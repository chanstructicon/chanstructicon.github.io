const root = document.body.dataset.root;
const isHome = document.body.dataset.network === "main";
const language = document.body.dataset.language || "en";
const networkId = isHome ? (language === "pt" ? "pt-main" : "main") : (new URLSearchParams(location.search).get("id") || "nword");
const WORK_IN_PROGRESS = "Work in progress — the Portuguese corpus is not available yet. You can explore the network and search the word list; original comments will be added later.";
let corpusAvailable = false;
const searchInput = document.querySelector("#term-search");
const searchResults = document.querySelector("#search-results");
const dataStatus = document.querySelector("#data-status");
const contextPanel = document.querySelector(".context-window");
const clearSelectionButton = document.querySelector("#clear-selection");
const postStatus = document.querySelector("#post-status");
const commentContent = document.querySelector("#comment-content");
const morePosts = document.querySelector("#more-posts");
const moreResults = document.querySelector("#more-results");
const cache = new Map();
let catalog;
let graph;
let graphData;
let vocabulary = [];
let ready = false;
let requestId = 0;
let selectedTerms = [];
let postRefs = [];
let postOffset = 0;
let resultLimit = 60;
let wordsByNode = new Map();
const POST_PAGE_SIZE = 25;

function json(path) {
  if (!cache.has(path)) {
    const promise = window.ChanData.load(path, root).catch(error => {
      cache.delete(path);
      throw error;
    });
    cache.set(path, promise);
    // Bound cached post chunks during long browsing sessions.
    if (cache.size > 70) {
      const oldestPost = [...cache.keys()].find(key => key.startsWith("data/posts/"));
      if (oldestPost) cache.delete(oldestPost);
    }
  }
  return cache.get(path);
}

function buildNodeTerms(data) {
  const byId = new Map(data.nodes.map(node => [node.id, node]));
  const children = new Map(data.nodes.map(node => [node.id, []]));
  for (const edge of data.edges) {
    // NetworkX emits undirected family edges in either order; the detailed
    // schema network already stores parent-to-child edges.
    if (byId.get(edge.target)?.type === "base") children.get(edge.target)?.push(edge.source);
    else children.get(edge.source)?.push(edge.target);
  }
  wordsByNode = new Map();
  for (const node of data.nodes) {
    const terms = new Set();
    const seen = new Set();
    const visit = id => {
      if (seen.has(id)) return;
      seen.add(id);
      const current = byId.get(id);
      if (!current) return;
      if (["word", "neo", "center"].includes(current.type)) terms.add(current.label.toLowerCase());
      for (const child of children.get(id) || []) visit(child);
    };
    if (["word", "neo"].includes(node.type)) terms.add(node.label.toLowerCase());
    else visit(node.id);
    if (!terms.size) terms.add(node.label.toLowerCase());
    wordsByNode.set(node.id, [...terms]);
  }
}

function highlight(text, terms) {
  const fragment = document.createDocumentFragment();
  const selected = new Set(terms);
  const tokens = /[a-z]+(?:['-][a-z]+)*/gi;
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    if (!selected.has(match[0].toLowerCase())) continue;
    fragment.append(document.createTextNode(text.slice(offset, match.index)));
    const mark = document.createElement("mark");
    mark.textContent = match[0];
    fragment.append(mark);
    offset = match.index + match[0].length;
  }
  fragment.append(document.createTextNode(text.slice(offset)));
  return fragment;
}

async function appendPosts(version) {
  if (!corpusAvailable) return;
  morePosts.disabled = true;
  const batch = postRefs.slice(postOffset, postOffset + POST_PAGE_SIZE);
  const terms = selectedTerms;
  try {
    const records = await Promise.all(batch.map(async ref => {
      const chunk = await json(`data/posts/${Math.floor(ref / catalog.chunkSize)}.json`);
      return chunk[ref % catalog.chunkSize];
    }));
    if (version !== requestId) return;
    for (const record of records) {
      const article = document.createElement("article");
      article.className = "comment-card";
      const meta = document.createElement("p");
      meta.className = "comment-meta";
      meta.textContent = [record.year, record.board ? `/${record.board}/` : "", record.thread_id ? `thread #${record.thread_id}` : ""].filter(Boolean).join(" · ");
      const context = document.createElement("p");
      context.className = "comment-meta";
      context.textContent = record.thread;
      const comment = document.createElement("p");
      comment.append(highlight(record.comment, terms));
      article.append(meta, context, comment);
      commentContent.append(article);
    }
    postOffset += records.length;
    postStatus.textContent = postRefs.length
      ? `${postRefs.length.toLocaleString("en")} matching posts · showing ${postOffset.toLocaleString("en")}`
      : "No matching posts in the supplied corpus.";
    morePosts.hidden = postOffset >= postRefs.length;
  } catch (error) {
    if (version !== requestId) return;
    postStatus.textContent = "These posts could not be loaded. Try again.";
    morePosts.hidden = false;
    morePosts.textContent = "RETRY";
    console.error(error);
  } finally {
    if (version === requestId) morePosts.disabled = false;
  }
}

async function showComments(label, terms, nodeId) {
  if (!ready) return;
  const version = ++requestId;
  selectedTerms = terms;
  postRefs = [];
  postOffset = 0;
  commentContent.replaceChildren();
  document.querySelector("#selected-word").textContent = label;
  postStatus.textContent = corpusAvailable ? "Loading matching posts..." : WORK_IN_PROGRESS;
  morePosts.hidden = true;
  morePosts.textContent = "MORE POSTS";
  graph.select(nodeId);
  if (contextPanel) {
    clearSelectionButton.disabled = false;
    contextPanel.querySelector(".post-body").scrollTop = 0;
    const parents = (graph.parentEdges.get(nodeId) || []).map(({ parent }) => parent.label);
    document.querySelector("#selection-path").textContent = parents.length
      ? `Parent${parents.length === 1 ? "" : "s"}: ${parents.join(" · ")} · path to root highlighted`
      : graph.selected ? "Root node · no parent nodes." : "This word has no node in the current network.";
    if (graph.childEdges.get(nodeId)?.length) {
      document.querySelector("#selection-path").textContent += " · all descendants highlighted";
    }
    if (matchMedia("(max-width: 899px)").matches) {
      contextPanel.scrollIntoView({ block: "start", behavior: "instant" });
    }
  }
  if (!corpusAvailable) return;
  try {
    const shards = [...new Set(terms.map(term => catalog.terms[term]?.shard).filter(shard => shard !== undefined))];
    const indexes = new Map(await Promise.all(shards.map(async shard => [shard, await json(`data/index/${shard}.json`)])));
    if (version !== requestId) return;
    const refs = new Set();
    for (const term of terms) {
      const shard = catalog.terms[term]?.shard;
      for (const ref of indexes.get(shard)?.[term] || []) refs.add(ref);
    }
    postRefs = [...refs].sort((a, b) => a - b);
    await appendPosts(version);
  } catch (error) {
    if (version !== requestId) return;
    postStatus.textContent = "The comment index could not be loaded. Select the word again to retry.";
    console.error(error);
  }
}

function runSearch(reset = true) {
  if (!ready) return;
  if (reset) resultLimit = 60;
  const query = searchInput.value.trim().toLowerCase();
  searchResults.replaceChildren();
  moreResults.hidden = true;
  if (!query) {
    dataStatus.textContent = `${vocabulary.length.toLocaleString("en")} words · type any word fragment.`;
    return;
  }
  const matches = vocabulary.filter(word => word.includes(query));
  const shown = matches.slice(0, resultLimit);
  dataStatus.textContent = `${matches.length.toLocaleString("en")} matches · showing ${shown.length.toLocaleString("en")}`;
  for (const term of shown) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "result-button";
    button.type = "button";
    button.textContent = term;
    button.addEventListener("click", () => {
      const node = graphData.nodes.find(node => ["word", "neo", "center"].includes(node.type) && node.label.toLowerCase() === term);
      showComments(term, [term], node?.id);
    });
    item.append(button);
    searchResults.append(item);
  }
  moreResults.hidden = shown.length >= matches.length;
}

async function initialize() {
  searchInput.disabled = true;
  document.querySelector("#search-button").disabled = true;
  try {
    const networks = await json("data/networks.json");
    const navigation = document.querySelector("#network-links");
    for (const network of networks.filter(item => (item.language || "en") === language)) {
      const link = document.createElement("a");
      link.href = network.id === "main" ? `${root}/en/index.html` : network.id === "pt-main"
        ? `${root}/pt/index.html` : `${root}/networks/index.html?id=${encodeURIComponent(network.id)}`;
      link.textContent = ["main", "pt-main"].includes(network.id) ? "main network" : network.title.replaceAll("_", " ");
      if (network.id === networkId) link.setAttribute("aria-current", "page");
      navigation.insertBefore(link, navigation.querySelector('[data-about-link]'));
    }
    const network = networks.find(item => item.id === networkId);
    if (!network || (network.language || "en") !== language) throw new Error("This network does not exist. Choose one of the networks above.");
    corpusAvailable = network.corpusAvailable !== false;
    document.querySelector("#network-title").textContent = network.title;
    const description = document.querySelector("#network-description");
    if (description) description.textContent = network.description;
    if (!isHome) document.title = `${network.title.replaceAll("_", " ")} — the CHAN-structicon`;
    graphData = await json(`data/${network.graph}`);
    if (graphData.primaryParentRule) {
      document.querySelector("#graph-help").textContent = "words sit with their heads · dashed links connect to modifiers · click to explore · drag to pan · scroll to zoom";
    }
    buildNodeTerms(graphData);
    graph = new window.ConstructiconGraph(
      document.querySelector("#network-canvas"),
      graphData,
      node => showComments(node.label, wordsByNode.get(node.id), node.id),
      {
        initialZoom: isHome ? 1.3 : 1,
        onDeselect: () => {
          document.querySelector("#selection-path").textContent = "";
        },
      }
    );
    document.querySelector("#graph-status").textContent = `${graphData.nodes.length.toLocaleString("en")} nodes · ${graphData.edges.length.toLocaleString("en")} connections`;
    catalog = corpusAvailable ? await json("data/catalog.json") : null;
    const wordList = isHome ? (catalog?.searchTerms ?? graphData.searchTerms) : null;
    vocabulary = [...new Set(wordList ?? graphData.nodes
      .filter(node => ["word", "neo", "center"].includes(node.type))
      .map(node => node.label.toLowerCase()))].sort((a, b) => a.localeCompare(b, language));
    if (!corpusAvailable) postStatus.textContent = WORK_IN_PROGRESS;
    if (graphData.provisional) {
      const note = document.querySelector("#data-note");
      note.hidden = false;
      note.textContent = "Provisional vocabulary: words containing the selected bases, extracted from the corpus. The research neologism list has not yet been supplied.";
    }
    ready = true;
    searchInput.disabled = false;
    document.querySelector("#search-button").disabled = false;
    runSearch();
  } catch (error) {
    if (!graph) document.querySelector("#graph-status").textContent = "Network unavailable.";
    const note = document.querySelector("#data-note");
    note.hidden = false;
    note.textContent = graph
      ? "The network is available, but its comment index could not be loaded. Reload the page to retry."
      : "The network data could not be loaded. Reload the page to retry.";
    dataStatus.textContent = error.message;
    console.error(error);
  }
}

document.querySelector("#search-button").addEventListener("click", () => runSearch());
searchInput.addEventListener("input", () => runSearch());
searchInput.addEventListener("keydown", event => { if (event.key === "Enter") runSearch(); });
moreResults.addEventListener("click", () => { resultLimit += 60; runSearch(false); });
morePosts.addEventListener("click", () => appendPosts(requestId));
clearSelectionButton?.addEventListener("click", () => {
  requestId++;
  selectedTerms = [];
  postRefs = [];
  postOffset = 0;
  commentContent.replaceChildren();
  morePosts.hidden = true;
  document.querySelector("#selected-word").textContent = "No word selected";
  document.querySelector("#selection-path").textContent = "";
  postStatus.textContent = corpusAvailable ? "Choose a node or a search result to read its original posts here." : WORK_IN_PROGRESS;
  graph?.select(null);
  contextPanel.querySelector(".post-body").scrollTop = 0;
  clearSelectionButton.disabled = true;
});
initialize();
