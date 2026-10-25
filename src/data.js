/* JSON over HTTP; generated data scripts when the HTML is opened locally. */
(() => {
  const pending = new Map();
  // Keep JSON and file:// wrappers in step with the HTML's script release.
  // Otherwise an older cached registry can hide newly introduced networks.
  const version = new URL(document.currentScript.src).searchParams.get("v");

  function register(path, value) {
    const request = pending.get(path);
    if (request) {
      request.value = value;
      request.registered = true;
    }
  }

  async function load(path, root) {
    const url = new URL(`${root}/${path}`, document.baseURI);
    if (version) url.searchParams.set("v", version);
    if (location.protocol !== "file:") {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load ${path} (${response.status}).`);
      return response.json();
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const request = { registered: false };
      pending.set(path, request);
      let timer;
      function finish(error) {
        clearTimeout(timer);
        script.remove();
        pending.delete(path);
        if (error) reject(error);
        else resolve(request.value);
      }
      script.onload = () => finish(request.registered ? null : new Error(`Invalid local data: ${path}.`));
      script.onerror = () => finish(new Error(`Could not load local data for ${path}.`));
      timer = setTimeout(() => finish(new Error(`Loading ${path} timed out.`)), 15000);
      url.pathname = url.pathname.replace(/\.json$/, ".local.js");
      script.src = url.href;
      document.head.append(script);
    });
  }

  window.ChanData = Object.freeze({ load, register });
})();
