const root = document.body.dataset.root;
const isHome = document.body.dataset.network === "main";
const language = document.body.dataset.language || "en";
const MAIN_NETWORK_BY_LANGUAGE = { en: "main", pt: "pt-main", nl: "nl-main" };
const MAIN_PAGE_BY_ID = { main: "en/index.html", "pt-main": "pt/index.html", "nl-main": "nl/index.html" };
const networkId = isHome ? (MAIN_NETWORK_BY_LANGUAGE[language] || `${language}-main`) : (new URLSearchParams(location.search).get("id") || "nword");
const WORK_IN_PROGRESS = "Work in progress — the Portuguese corpus is not available yet. You can explore the network and search the word list; original comments will be added later.";
let corpusAvailable = false;
let corpusRoot = "data";
const searchInput = document.querySelector("#term-search");
const searchResults = document.querySelector("#search-results");
const dataStatus = document.querySelector("#data-status");
const contextPanel = document.querySelector(".context-window");
const clearSelectionButton = document.querySelector("#clear-selection");
const postStatus = document.querySelector("#post-status");
const commentContent = document.querySelector("#comment-content");
const morePosts = document.querySelector("#more-posts");
const moreResults = document.querySelector("#more-results");
const wordListButton = document.querySelector("#show-word-list");
const wordListDialog = document.querySelector("#word-list-dialog");
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
      const oldestPost = [...cache.keys()].find(key => /^data\/(?:[^/]+\/)?posts\//.test(key));
      if (oldestPost) cache.delete(oldestPost);
    }
  }
  return cache.get(path);
}

function foldTerm(value) {
  return value.toLowerCase().replaceAll("ß", "ss");
}

function populateWordList(title) {
  const words = [...new Set(graphData.nodes
    .filter(node => ["word", "neo"].includes(node.type) && !graph.childEdges.get(node.id)?.length)
    .map(node => node.label))].sort((a, b) => a.localeCompare(b, language));
  const items = document.createDocumentFragment();
  for (const word of words) {
    const item = document.createElement("li");
    item.textContent = word;
    items.append(item);
  }
  document.querySelector("#word-list").replaceChildren(items);
  document.querySelector("#word-list-title").textContent = `${title.replaceAll("_", " ")} · WORD LIST`;
  document.querySelector("#word-list-count").textContent = `${words.length.toLocaleString(language)} child words · alphabetical order`;
  wordListButton.disabled = false;
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
      if (["word", "neo", "center"].includes(current.type)) terms.add(foldTerm(current.label));
      for (const child of children.get(id) || []) visit(child);
    };
    if (["word", "neo"].includes(node.type)) terms.add(foldTerm(node.label));
    else visit(node.id);
    if (!terms.size) terms.add(foldTerm(node.label));
    wordsByNode.set(node.id, [...terms]);
  }
}

function highlight(text, terms, forms) {
  const fragment = document.createDocumentFragment();
  const selected = new Set();
  for (const term of terms) {
    selected.add(foldTerm(term));
    for (const surface of forms?.[term] || []) selected.add(foldTerm(surface));
  }
  const tokens = /\p{L}+(?:['-]\p{L}+)*/giu;
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    if (!selected.has(foldTerm(match[0]))) continue;
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
      const chunk = await json(`${corpusRoot}/posts/${Math.floor(ref / catalog.chunkSize)}.json`);
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
      comment.append(highlight(record.comment, terms, record.forms));
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
    const indexes = new Map(await Promise.all(shards.map(async shard => [shard, await json(`${corpusRoot}/index/${shard}.json`)])));
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
  const query = foldTerm(searchInput.value.trim());
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
      const node = graphData.nodes.find(node => ["word", "neo", "center"].includes(node.type) && foldTerm(node.label) === term);
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
    const languageNetworks = networks.filter(item => (item.language || "en") === language);
    for (const network of languageNetworks) {
      if (languageNetworks.length === 1) continue;
      const link = document.createElement("a");
      const mainPage = MAIN_PAGE_BY_ID[network.id];
      link.href = mainPage ? `${root}/${mainPage}` : `${root}/networks/index.html?id=${encodeURIComponent(network.id)}`;
      link.textContent = mainPage ? "main network" : network.title.replaceAll("_", " ");
      if (network.id === networkId) link.setAttribute("aria-current", "page");
      navigation.insertBefore(link, navigation.querySelector('[data-about-link]'));
    }
    const network = networks.find(item => item.id === networkId);
    if (!network || (network.language || "en") !== language) throw new Error("This network does not exist. Choose one of the networks above.");
    corpusAvailable = network.corpusAvailable !== false;
    corpusRoot = network.corpus ? `data/${network.corpus}` : "data";
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
    populateWordList(network.title);
    catalog = corpusAvailable ? await json(`${corpusRoot}/catalog.json`) : null;
    const wordList = isHome ? (catalog?.searchTerms ?? graphData.searchTerms) : null;
    vocabulary = [...new Set(wordList ?? graphData.nodes
      .filter(node => ["word", "neo", "center"].includes(node.type))
      .map(node => foldTerm(node.label)))].sort((a, b) => a.localeCompare(b, language));
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

wordListButton.addEventListener("click", () => {
  wordListDialog.showModal();
  wordListDialog.querySelector(".word-list-body").scrollTop = 0;
});
wordListDialog.addEventListener("click", event => {
  if (event.target !== wordListDialog) return;
  const bounds = wordListDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
    wordListDialog.close();
  }
});

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
