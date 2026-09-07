(function(){
  "use strict";
  var doc = document, root = doc.documentElement, body = doc.body;
  var viewer     = doc.getElementById("viewer");
  var empty      = doc.getElementById("empty");
  var fileInput  = doc.getElementById("fileInput");
  var overlay    = doc.getElementById("dropOverlay");
  var toastEl    = doc.getElementById("toast");
  var docTitle   = doc.getElementById("docTitle");
    var brandIcon   = doc.getElementById("brandIcon");
    (function(){ var fl = doc.querySelector('link[rel="icon"]'); if (brandIcon && fl) brandIcon.src = fl.href; })();
  var bgPicker   = doc.getElementById("bgPicker");
  var themeColor = doc.getElementById("themeColor");
  var tocPanel   = doc.getElementById("tocPanel");
  var tocList    = doc.getElementById("tocList");
  var scrim      = doc.getElementById("scrim");
  var pageNav    = doc.getElementById("pageNav");
  var btnPrev    = doc.getElementById("btnPrev");
  var btnNext    = doc.getElementById("btnNext");
  var pageInput  = doc.getElementById("pageInput");
  var pageCount  = doc.getElementById("pageCount");
  var btnToc     = doc.getElementById("btnToc");
  var btnZoomIn  = doc.getElementById("btnZoomIn");
  var btnZoomOut = doc.getElementById("btnZoomOut");
  var zoomLabel  = doc.getElementById("zoomLabel");
  var toastTimer = null;
  var BASE_TITLE = "PDF Viewer";
  var pdfjsLib   = window.pdfjsLib;

  // Header auto-hide (scroll down hides; scroll up or a 5s idle reveals)
  var HEADER_REVEAL_MS = 3000;   // idle time before the header collapses to the handle
  var lastScrollY = 0, headerTimer = null, hdrTicking = false;

  // Accepted file types for this (PDF) viewer
  var ACCEPTED_EXT = [".pdf"];

  var MIN_SCALE = 0.2, MAX_SCALE = 6;
  var DPR = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));

  /* ---------- Worker: run pdf.js off the main thread from an inline blob.
     If the browser blocks blob workers, pdf.js transparently falls back to a
     main-thread "fake worker", so rendering still works (e.g. from file://). */
  if (pdfjsLib){
    try{
      var wsrc = doc.getElementById("pdfWorker");
      if (wsrc && wsrc.textContent){
        var wblob = new Blob([wsrc.textContent], { type: "text/javascript" });
        pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(wblob);
      }
    }catch(e){}
  }

  /* ---------- State ---------- */
  var pdfDoc = null;      // current PDFDocumentProxy
  var loadingTask = null; // current getDocument task
  var numPages = 0;
  var pages = [];         // per page: { num, div, canvas, textLayer, natW, natH, ratio, scale, sized, rendered, rendering, task, textTask, loaded }
  var docSeq = 0;         // bumped on every open/clear; invalidates stale async work
  var zoomMode = "fit";   // "fit" (fit-width) or a numeric absolute scale
  var currentPage = 1;
  var io = null;          // lazy-render observer
  var visIo = null;       // current-page observer
  var resizeTimer = null;

  function toast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove("show"); }, 2100);
  }
  function clamp(n, lo, hi){ return n < lo ? lo : (n > hi ? hi : n); }

  /* ---------- Reading a file ---------- */
  function isAcceptedName(name){
    name = (name || "").toLowerCase();
    for (var i = 0; i < ACCEPTED_EXT.length; i++){
      if (name.slice(-ACCEPTED_EXT[i].length) === ACCEPTED_EXT[i]) return true;
    }
    return false;
  }
  function readFile(file){
    if (!file) return;
    var name = (file.name || "");
    // Validate the file type BEFORE trying to display it. A rejected file gets
    // the family router's offer card first (§6.10); the toast is the fallback.
    if (!isAcceptedName(name) && (file.type || "").indexOf("pdf") === -1){
      if (!familyRoute(file)) toast("Unsupported file — this viewer opens PDF files (.pdf) only");
      return;
    }
    var reader = new FileReader();
    reader.onload  = function(e){ openPdf(new Uint8Array(e.target.result), name); };
    reader.onerror = function(){ toast("Could not read that file"); };
    reader.readAsArrayBuffer(file);
  }

  // Reflect the loaded file's name into the URL (?name=), so a bookmarked or
  // shared link says what was being viewed. history.replaceState only, and
  // URLSearchParams does its own percent-encoding — this never touches the
  // DOM, so it carries no XSS risk on its own. The value becomes untrusted
  // input again the moment it is read back (see the on-load block near the
  // bottom of this script), and that path must stay textContent-only.
  function syncQueryName(name){
    var url = new URL(location.href);
    if (name) url.searchParams.set("name", name);
    else url.searchParams.delete("name");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  function openPdf(data, name){
    if (!pdfjsLib){ toast("Viewer failed to load its PDF engine"); return; }
    clearAll();
    syncQueryName(name);              // after clearAll(), which clears it; names the FILE,
                                      // not the title — startDocument() may prefer the PDF's
                                      // own Title metadata, which is a different fact
    var seq = docSeq;                 // clearAll() just bumped docSeq
    var fallbackTitle = name ? name.replace(/\.pdf$/i, "") : "Untitled PDF";
    body.classList.add("loading");
    docTitle.textContent = "Opening…";

    try{
      loadingTask = pdfjsLib.getDocument({ data: data, isEvalSupported: false });
    }catch(err){ failOpen(seq, err); return; }

    loadingTask.onPassword = function(updatePassword, reason){
      if (seq !== docSeq) return;
      var again = pdfjsLib.PasswordResponses && reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
      var pw = window.prompt(again ? "Incorrect password — try again:" : "This PDF is password-protected. Enter its password:");
      if (pw === null){ try{ loadingTask.destroy(); }catch(e){} failOpen(seq, { name: "PasswordCancelled" }); }
      else updatePassword(pw);
    };

    loadingTask.promise.then(function(pdf){
      if (seq !== docSeq){ try{ pdf.destroy(); }catch(e){} return; }
      pdfDoc = pdf;
      numPages = pdf.numPages;
      startDocument(fallbackTitle, seq);
    }, function(err){
      failOpen(seq, err);
    });
  }

  function failOpen(seq, err){
    if (seq !== docSeq) return;
    var name = (err && (err.name || err.message)) || "";
    clearAll();
    if (/PasswordCancelled/.test(name)) return;           // user dismissed the prompt
    if (/Password/i.test(name)) toast("This PDF is password-protected");
    else if (/InvalidPDF|Invalid PDF|structure/i.test(name)) toast("That doesn't look like a valid PDF");
    else toast("Couldn't open that PDF");
  }

  /* ---------- Document setup ---------- */
  function startDocument(fallbackTitle, seq){
    body.classList.remove("loading");
    empty.hidden = true;
    viewer.hidden = false;
    pageNav.hidden = false;
    body.classList.add("viewing");
    revealHeader();               // show, then collapse to the handle after 3s
    lastScrollY = 0;
    currentPage = 1;
    zoomMode = "fit";
    pageCount.textContent = numPages;
    pageInput.max = numPages;
    setTitle(fallbackTitle);

    // Prefer the PDF's own Title metadata, fall back to the file name.
    pdfDoc.getMetadata().then(function(m){
      if (seq !== docSeq) return;
      var t = m && m.info && (m.info.Title || "").trim();
      if (t) setTitle(t);
    }, function(){});

    buildPages(seq);
    buildOutline(seq);
    updatePageNav();
    applyZoomLabel();
  }

  function setTitle(t){
    docTitle.textContent = t;
    doc.title = t ? (t + " — " + BASE_TITLE) : BASE_TITLE;
  }

  /* ---------- Page placeholders + lazy rendering ---------- */
  function viewerContentWidth(){
    var cs = getComputedStyle(viewer);
    var pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
    return Math.max(60, viewer.clientWidth - pl - pr);
  }
  function displayScaleFor(rec){
    if (zoomMode === "fit") return viewerContentWidth() / rec.natW;
    return zoomMode;
  }
  function sizePage(rec){
    var scale = displayScaleFor(rec);
    rec.scale = scale;
    var w = Math.round(rec.natW * scale), h = Math.round(rec.natH * scale);
    rec.div.style.width  = w + "px";
    rec.div.style.height = h + "px";
    rec.div.style.setProperty("--scale-factor", scale);
  }
  function recordSize(rec, vp1){
    rec.natW = vp1.width; rec.natH = vp1.height;
    rec.ratio = vp1.height / vp1.width; rec.sized = true;
    if (!rec.rendered && !rec.rendering) sizePage(rec);
  }

  function setupObservers(){
    if (io) io.disconnect();
    if (visIo) visIo.disconnect();
    io = new IntersectionObserver(onIntersect, { root: viewer, rootMargin: "150% 0px 150% 0px" });
    // A thin band across the middle of the viewport marks the "current" page.
    visIo = new IntersectionObserver(onVisible, { root: viewer, rootMargin: "-45% 0px -45% 0px" });
  }
  function onIntersect(entries){
    for (var i = 0; i < entries.length; i++){
      var rec = entries[i].target.__rec;
      if (!rec) continue;
      if (entries[i].isIntersecting) renderPage(rec);
      else discardPage(rec);
    }
  }
  function onVisible(entries){
    var best = 0, bestRec = null;
    for (var i = 0; i < entries.length; i++){
      if (entries[i].isIntersecting && entries[i].intersectionRatio >= best){
        best = entries[i].intersectionRatio; bestRec = entries[i].target.__rec;
      }
    }
    if (bestRec && bestRec.num !== currentPage){
      currentPage = bestRec.num;
      updatePageNav();
    }
  }

  function buildPages(seq){
    viewer.textContent = "";
    pages = [];
    setupObservers();
    pdfDoc.getPage(1).then(function(p1){
      if (seq !== docSeq) return;
      var vp1 = p1.getViewport({ scale: 1 });
      for (var i = 1; i <= numPages; i++){
        var div = doc.createElement("div");
        div.className = "page";
        div.setAttribute("data-page", i);
        var rec = {
          num: i, div: div, canvas: null, textLayer: null,
          natW: vp1.width, natH: vp1.height, ratio: vp1.height / vp1.width,
          scale: 1, sized: (i === 1), rendered: false, rendering: false,
          task: null, textTask: null, gen: 0
        };
        div.__rec = rec;
        pages.push(rec);
        sizePage(rec);
        viewer.appendChild(div);
        io.observe(div);
        visIo.observe(div);
      }
      recordSize(pages[0], vp1);
      measureFrom(seq, 2);
    }, function(){
      if (seq === docSeq){ toast("Couldn't read this PDF"); clearAll(); }
    });
  }

  // Measure exact page sizes in the background so the scrollbar is accurate,
  // without blocking the first paint. Yields between pages.
  function measureFrom(seq, start){
    var i = start;
    var idle = window.requestIdleCallback || function(fn){ return setTimeout(fn, 0); };
    function next(){
      if (seq !== docSeq || i > numPages) return;
      var pnum = i;
      pdfDoc.getPage(pnum).then(function(page){
        if (seq !== docSeq) return;
        var rec = pages[pnum - 1];
        if (rec) recordSize(rec, page.getViewport({ scale: 1 }));
        i = pnum + 1; idle(next);
      }, function(){ i = pnum + 1; idle(next); });
    }
    next();
  }

  function renderPage(rec){
    if (!pdfDoc || rec.rendered || rec.rendering) return;
    rec.rendering = true;
    // Generation token: getPage() is async and rec.task isn't assigned until it
    // resolves, so a discard/reflow/re-render that happens while getPage is
    // pending can't cancel via rec.task. Bumping rec.gen lets those callers
    // supersede this render; the resolve handlers bail when rec.gen moved on.
    var myGen = ++rec.gen;
    rec.div.classList.add("is-loading");
    var seq = docSeq;
    pdfDoc.getPage(rec.num).then(function(page){
      if (seq !== docSeq || rec.gen !== myGen){ if (rec.gen === myGen) rec.rendering = false; return; }
      if (!rec.sized){
        var vp1 = page.getViewport({ scale: 1 });
        rec.natW = vp1.width; rec.natH = vp1.height;
        rec.ratio = vp1.height / vp1.width; rec.sized = true;
      }
      var scale = displayScaleFor(rec);
      rec.scale = scale;
      var vp = page.getViewport({ scale: scale });

      // Keep the placeholder box exactly matching what we're about to paint,
      // so the layout height is correct and the text layer aligns.
      var cw = Math.round(vp.width), ch = Math.round(vp.height);
      rec.div.style.width = cw + "px";
      rec.div.style.height = ch + "px";
      rec.div.style.setProperty("--scale-factor", scale);

      var canvas = doc.createElement("canvas");
      canvas.className = "page-canvas";
      canvas.width  = Math.max(1, Math.floor(vp.width  * DPR));
      canvas.height = Math.max(1, Math.floor(vp.height * DPR));
      canvas.style.width  = cw + "px";
      canvas.style.height = ch + "px";
      var ctx = canvas.getContext("2d", { alpha: false });

      var task = page.render({
        canvasContext: ctx,
        viewport: vp,
        transform: DPR !== 1 ? [DPR, 0, 0, DPR, 0, 0] : null
      });
      rec.task = task;
      task.promise.then(function(){
        if (seq !== docSeq || rec.gen !== myGen){ if (canvas){ canvas.width = 0; canvas.height = 0; } return; }
        rec.div.classList.remove("is-loading");
        rec.div.textContent = "";
        rec.div.appendChild(canvas);
        rec.canvas = canvas;
        rec.rendered = true; rec.rendering = false; rec.task = null;
        renderTextLayer(rec, page, vp, seq, myGen);
      }, function(){
        // RenderingCancelledException (zoom/scroll) or a genuine error — reset so it can retry.
        if (canvas){ canvas.width = 0; canvas.height = 0; }
        if (rec.gen === myGen){ rec.rendering = false; rec.task = null; rec.div.classList.remove("is-loading"); }
      });
    }, function(){
      if (rec.gen === myGen){ rec.rendering = false; rec.div.classList.remove("is-loading"); }
    });
  }

  function renderTextLayer(rec, page, vp, seq, myGen){
    if (!pdfjsLib.renderTextLayer) return;
    try{
      var tl = doc.createElement("div");
      tl.className = "textLayer";
      tl.style.width  = Math.round(vp.width)  + "px";
      tl.style.height = Math.round(vp.height) + "px";
      rec.div.appendChild(tl);
      rec.textLayer = tl;
      page.getTextContent().then(function(tc){
        if (seq !== docSeq || rec.gen !== myGen || rec.textLayer !== tl) return;
        var t = pdfjsLib.renderTextLayer({
          textContentSource: tc,
          container: tl,
          viewport: vp,
          textDivs: []
        });
        rec.textTask = t;
        if (t && t.promise && t.promise.catch) t.promise.catch(function(){});
      }, function(){});
    }catch(e){}
  }

  function discardPage(rec){
    rec.gen++;                 // supersede any render whose getPage() is still pending
    if (rec.task){ try{ rec.task.cancel(); }catch(e){} rec.task = null; }
    if (rec.textTask && rec.textTask.cancel){ try{ rec.textTask.cancel(); }catch(e){} }
    rec.textTask = null;
    rec.rendering = false;
    rec.div.classList.remove("is-loading");
    if (rec.canvas){ rec.canvas.width = 0; rec.canvas.height = 0; }
    if (rec.rendered || rec.canvas || rec.textLayer){
      rec.div.textContent = "";
      rec.canvas = null; rec.textLayer = null; rec.rendered = false;
    }
  }

  /* ---------- Zoom ---------- */
  function applyZoomLabel(){
    zoomLabel.textContent = (zoomMode === "fit") ? "Fit" : Math.round(zoomMode * 100) + "%";
  }
  function referenceScale(){
    var rec = pages[currentPage - 1] || pages[0];
    if (!rec) return 1;
    return (zoomMode === "fit") ? (viewerContentWidth() / rec.natW) : zoomMode;
  }
  function setZoom(mode){
    if (!pdfDoc) return;
    var a = anchor();
    zoomMode = mode;
    reflow();
    restore(a);
    applyZoomLabel();
  }
  function zoomBy(factor){
    var s = clamp(referenceScale() * factor, MIN_SCALE, MAX_SCALE);
    setZoom(s);
  }
  function reflow(){
    for (var i = 0; i < pages.length; i++){
      var rec = pages[i];
      rec.gen++;               // supersede any render whose getPage() is still pending
      if (rec.task){ try{ rec.task.cancel(); }catch(e){} rec.task = null; }
      if (rec.textTask && rec.textTask.cancel){ try{ rec.textTask.cancel(); }catch(e){} }
      rec.textTask = null; rec.rendering = false;
      if (rec.canvas){ rec.canvas.width = 0; rec.canvas.height = 0; }
      rec.canvas = null; rec.textLayer = null; rec.rendered = false;
      rec.div.classList.remove("is-loading");
      rec.div.textContent = "";
      sizePage(rec);
    }
    renderNearViewport();
  }
  // After a reflow the IntersectionObserver won't re-fire (elements stay
  // observed and still intersect), so render the near-viewport pages by hand.
  function renderNearViewport(){
    var top = viewer.scrollTop - viewer.clientHeight * 1.5;
    var bot = viewer.scrollTop + viewer.clientHeight * 2.5;
    for (var i = 0; i < pages.length; i++){
      var d = pages[i].div, oTop = d.offsetTop, oBot = oTop + d.offsetHeight;
      if (oBot >= top && oTop <= bot) renderPage(pages[i]);
    }
  }
  function anchor(){
    var st = viewer.scrollTop;
    for (var i = 0; i < pages.length; i++){
      var d = pages[i].div, oTop = d.offsetTop, oBot = oTop + d.offsetHeight;
      if (oBot > st) return { idx: i, frac: (st - oTop) / Math.max(1, d.offsetHeight) };
    }
    return { idx: 0, frac: 0 };
  }
  function restore(a){
    if (!a) return;
    var d = pages[a.idx] && pages[a.idx].div;
    if (d) viewer.scrollTop = d.offsetTop + a.frac * d.offsetHeight;
  }

  /* ---------- Page navigation ---------- */
  function updatePageNav(){
    pageCount.textContent = numPages;
    if (doc.activeElement !== pageInput) pageInput.value = currentPage;
    btnPrev.disabled = currentPage <= 1;
    btnNext.disabled = currentPage >= numPages;
  }
  function goToPage(n){
    if (!pdfDoc) return;
    n = clamp(Math.round(n) || 1, 1, numPages);
    var d = pages[n - 1] && pages[n - 1].div;
    if (!d) return;
    viewer.scrollTo({ top: Math.max(0, d.offsetTop - 8), behavior: "auto" });
    currentPage = n;
    updatePageNav();
  }

  /* ---------- Outline ---------- */
  function buildOutline(seq){
    tocList.textContent = "";
    pdfDoc.getOutline().then(function(outline){
      if (seq !== docSeq) return;
      if (outline && outline.length){
        tocList.appendChild(buildOutlineLevel(outline));
      } else {
        var ul = doc.createElement("ul");
        for (var i = 1; i <= numPages; i++){
          var li = doc.createElement("li"), a = doc.createElement("a");
          a.textContent = "Page " + i;
          a.href = "#";
          a.setAttribute("data-page", i);
          li.appendChild(a); ul.appendChild(li);
        }
        tocList.appendChild(ul);
      }
    }, function(){
      if (seq !== docSeq) return;
      var p = doc.createElement("p");
      p.className = "toc-empty";
      p.textContent = "No outline in this PDF.";
      tocList.appendChild(p);
    });
  }
  function buildOutlineLevel(items){
    var ul = doc.createElement("ul");
    for (var i = 0; i < items.length; i++){
      var it = items[i], li = doc.createElement("li"), a = doc.createElement("a");
      a.textContent = (it.title || "Untitled").replace(/\s+/g, " ").trim() || "Untitled";
      a.href = "#";
      a.__dest = it.dest;
      li.appendChild(a);
      if (it.items && it.items.length) li.appendChild(buildOutlineLevel(it.items));
      ul.appendChild(li);
    }
    return ul;
  }
  function resolveDest(dest){
    return Promise.resolve().then(function(){
      if (!pdfDoc || !dest) return null;
      return (typeof dest === "string") ? pdfDoc.getDestination(dest) : dest;
    }).then(function(arr){
      if (!pdfDoc || !arr || !arr.length) return null;
      var ref = arr[0];
      if (ref == null) return null;
      if (typeof ref === "number") return ref + 1;
      return pdfDoc.getPageIndex(ref).then(function(idx){ return idx + 1; });
    }).catch(function(){ return null; });
  }
  tocList.addEventListener("click", function(ev){
    var a = ev.target && ev.target.closest ? ev.target.closest("a") : null;
    if (!a) return;
    ev.preventDefault();
    if (!pdfDoc) return;
    if (a.hasAttribute("data-page")){
      closeToc(); goToPage(parseInt(a.getAttribute("data-page"), 10)); return;
    }
    var seq = docSeq;
    resolveDest(a.__dest).then(function(pg){
      if (seq !== docSeq) return;                 // document cleared mid-resolve
      if (pg){ closeToc(); goToPage(pg); }
      else toast("Couldn't resolve that outline link");
    });
  });

  function openTocPanel(){
    if (!pdfDoc){ toast("Open a PDF first"); return; }
    tocPanel.classList.add("open");
    scrim.classList.add("show");
    btnToc.setAttribute("aria-expanded", "true");
  }
  function closeToc(){
    tocPanel.classList.remove("open");
    scrim.classList.remove("show");
    btnToc.setAttribute("aria-expanded", "false");
  }
  btnToc.addEventListener("click", function(){
    if (tocPanel.classList.contains("open")) closeToc(); else openTocPanel();
  });
  doc.getElementById("btnTocClose").addEventListener("click", closeToc);
  scrim.addEventListener("click", closeToc);

  /* ---------- Clearing ---------- */
  function clearAll(){
    docSeq++;
    syncQueryName("");
    if (loadingTask){ try{ loadingTask.destroy(); }catch(e){} loadingTask = null; }
    if (io) io.disconnect();
    if (visIo) visIo.disconnect();
    for (var i = 0; i < pages.length; i++){
      var rec = pages[i];
      if (rec.task){ try{ rec.task.cancel(); }catch(e){} }
      if (rec.textTask && rec.textTask.cancel){ try{ rec.textTask.cancel(); }catch(e){} }
      if (rec.canvas){ rec.canvas.width = 0; rec.canvas.height = 0; }
    }
    pages = [];
    if (pdfDoc){ try{ pdfDoc.destroy(); }catch(e){} pdfDoc = null; }
    numPages = 0; currentPage = 1; zoomMode = "fit";
    viewer.textContent = "";
    viewer.hidden = true;
    empty.hidden = false;
    pageNav.hidden = true;
    tocList.textContent = "";
    closeToc();
    setTitle("");
    clearTimeout(headerTimer);
    lastScrollY = 0;
    body.classList.remove("viewing", "hdr-hidden", "loading");
    applyZoomLabel();
  }

  /* ---------- Controls ---------- */
  function openDialog(){ fileInput.click(); }

  fileInput.addEventListener("change", function(e){
    var f = e.target.files && e.target.files[0];
    if (f) readFile(f);
    fileInput.value = "";
  });

  doc.getElementById("btnClear").addEventListener("click", clearAll);
  doc.getElementById("btnFooterClose").addEventListener("click", function(){
    doc.getElementById("footer").hidden = true;
  });

  // ---------- Family nav (hamburger flyout) ----------
  var btnMenu = doc.getElementById("btnMenu"), navBackdrop = doc.getElementById("navBackdrop");
  function setNav(open){
    if (open) closeToc();                 // don't stack the family nav over the outline panel
    body.classList.toggle("nav-open", open);
    btnMenu.setAttribute("aria-expanded", open ? "true" : "false");
  }
  btnMenu.addEventListener("click", function(){ setNav(!body.classList.contains("nav-open")); });
  navBackdrop.addEventListener("click", function(){ setNav(false); });
  doc.addEventListener("keydown", function(e){
    if (!id("routeCard").hidden){                        // route card is modal (§6.10)
      if (e.key === "Escape"){ hideRouteCard(); return; }
      if (e.key === "Tab"){                              // two-button focus trap: aria-modal, so focus must not walk beneath the backdrop
        e.preventDefault();
        var go = id("routeGo"), no = id("routeDismiss");
        (doc.activeElement === go || go.disabled ? no : go).focus();
        return;
      }
    }
    if (e.key === "Escape") setNav(false);
  });

  empty.addEventListener("click", openDialog);
  empty.addEventListener("keydown", function(e){
    if (e.key === "Enter" || e.key === " "){ e.preventDefault(); openDialog(); }
  });

  btnPrev.addEventListener("click", function(){ goToPage(currentPage - 1); });
  btnNext.addEventListener("click", function(){ goToPage(currentPage + 1); });
  btnZoomIn.addEventListener("click", function(){ zoomBy(1.25); });
  btnZoomOut.addEventListener("click", function(){ zoomBy(0.8); });
  zoomLabel.addEventListener("click", function(){ setZoom("fit"); });

  pageInput.addEventListener("change", function(){ goToPage(parseInt(pageInput.value, 10)); });
  pageInput.addEventListener("keydown", function(e){
    if (e.key === "Enter"){ e.preventDefault(); goToPage(parseInt(pageInput.value, 10)); pageInput.blur(); }
  });

  /* ---------- Copy ---------- */
  doc.getElementById("btnCopy").addEventListener("click", function(){
    var sel = window.getSelection ? window.getSelection() : null;
    var selText = sel && sel.toString ? sel.toString().trim() : "";
    if (selText){ copyText(selText, "Selection copied"); return; }
    if (!pdfDoc){ toast("Nothing to copy yet"); return; }
    var seq = docSeq, n = currentPage;
    pdfDoc.getPage(n).then(function(p){ return p.getTextContent(); }).then(function(tc){
      if (seq !== docSeq) return;
      var out = "", items = tc.items || [];
      for (var i = 0; i < items.length; i++){
        out += items[i].str || "";
        if (items[i].hasEOL) out += "\n";
      }
      out = out.replace(/[ \t]+\n/g, "\n").trim();
      if (!out){ toast("This page has no selectable text"); return; }
      copyText(out, "Page " + n + " text copied");
    }, function(){ if (seq === docSeq) toast("Couldn't read this page's text"); });
  });
  function copyText(text, okMsg){
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){ toast(okMsg); }, function(){ fallbackCopy(text, okMsg); });
    } else {
      fallbackCopy(text, okMsg);
    }
  }
  function fallbackCopy(text, okMsg){
    var ta = doc.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.opacity = "0";
    doc.body.appendChild(ta); ta.select();
    try{ doc.execCommand("copy"); toast(okMsg); }
    catch(err){ toast("Copy not supported"); }
    doc.body.removeChild(ta);
  }

  /* ---------- Keyboard ---------- */
  window.addEventListener("keydown", function(e){
    if (e.key === "Escape"){ closeToc(); return; }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (!pdfDoc) return;
    var t = e.target, tag = (t && t.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || (t && t.isContentEditable)) return;
    if (e.key === "ArrowRight" || e.key === "PageDown"){ e.preventDefault(); goToPage(currentPage + 1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp"){ e.preventDefault(); goToPage(currentPage - 1); }
    else if (e.key === "Home"){ e.preventDefault(); goToPage(1); }
    else if (e.key === "End"){ e.preventDefault(); goToPage(numPages); }
    else if ((e.key === "+" || e.key === "=")){ e.preventDefault(); zoomBy(1.25); }
    else if (e.key === "-" || e.key === "_"){ e.preventDefault(); zoomBy(0.8); }
    else if (e.key === "0"){ e.preventDefault(); setZoom("fit"); }
  });

  /* ---------- Auto-hiding header: hide on scroll down; reveal on scroll up or after 5s ---------- */
  function showHeader(){ body.classList.remove("hdr-hidden"); clearTimeout(headerTimer); }
  function hideHeader(){ if (!body.classList.contains("viewing")) return; body.classList.add("hdr-hidden"); clearTimeout(headerTimer); }
  function armIdleHide(){ clearTimeout(headerTimer); headerTimer = setTimeout(hideHeader, HEADER_REVEAL_MS); }
  function revealHeader(){ showHeader(); armIdleHide(); }
  viewer.addEventListener("scroll", function(){
    if (hdrTicking) return;
    hdrTicking = true;
    requestAnimationFrame(function(){
      hdrTicking = false;
      var y = viewer.scrollTop, dy = y - lastScrollY;
      lastScrollY = y;
      if (!pdfDoc) return;
      if (dy > 6) hideHeader();            // scrolling down -> collapse to the handle
      else if (dy < -6) revealHeader();    // scrolling up   -> reveal, then auto-hide after 3s
    });
  }, { passive: true });
  // reveal via the top strip / handle (hover, tap, click); keep it up while the pointer is on the header
  var hoverZone = document.getElementById("hoverZone");
  if (hoverZone){
    hoverZone.addEventListener("mouseenter", revealHeader);
    hoverZone.addEventListener("click", revealHeader);
    hoverZone.addEventListener("touchstart", function(){ revealHeader(); }, { passive:true });
  }
  var topbarEl = document.querySelector(".topbar");
  if (topbarEl){
    topbarEl.addEventListener("mouseenter", showHeader);
    topbarEl.addEventListener("mouseleave", armIdleHide);
  }

  /* ---------- Resize: re-fit when in fit-width mode ---------- */
  window.addEventListener("resize", function(){
    if (!pdfDoc) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function(){
      DPR = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
      if (zoomMode === "fit"){ var a = anchor(); reflow(); restore(a); }
    }, 160);
  });

  /* ---------- Background color (chosen by the user, remembered in a cookie) ---------- */
  function setCookie(name, val){
    doc.cookie = name + "=" + encodeURIComponent(val) + "; max-age=31536000; path=/; SameSite=Lax";
  }
  function getCookie(name){
    var m = doc.cookie.match("(?:^|; )" + name.replace(/([.*+?^${}()|[\]\\])/g, "\\$1") + "=([^;]*)");
    return m ? decodeURIComponent(m[1]) : null;
  }
  function hexToRgb(h){
    h = h.replace("#", "");
    if (h.length === 3) h = h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2);
    var n = parseInt(h, 16);
    return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 };
  }
  function srgb(c){ c/=255; return c<=0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); }
  function luminance(rgb){ return 0.2126*srgb(rgb.r) + 0.7152*srgb(rgb.g) + 0.0722*srgb(rgb.b); }
  function mix(a, b, t){
    return "rgb(" + Math.round(a.r+(b.r-a.r)*t) + "," + Math.round(a.g+(b.g-a.g)*t) + "," + Math.round(a.b+(b.b-a.b)*t) + ")";
  }
  function rgbStr(c){ return "rgb(" + c.r + "," + c.g + "," + c.b + ")"; }

  function applyColor(hex){
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) hex = "#ffffff";
    var bg = hexToRgb(hex);
    var lightText = luminance(bg) <= 0.179;                 // dark background -> light UI text
    var text = lightText ? { r:240, g:243, b:246 } : { r:31, g:35, b:40 };
    var accentHex = lightText ? "#8b93ff" : "#4f46e5";
    var ac = hexToRgb(accentHex);
    var s = root.style;
    s.setProperty("--bg", hex);
    s.setProperty("--surface", hex);
    s.setProperty("--text", rgbStr(text));
    s.setProperty("--muted", mix(bg, text, 0.45));
    s.setProperty("--border", mix(bg, text, 0.24));
    s.setProperty("--border-soft", mix(bg, text, 0.13));
    s.setProperty("--hover", mix(bg, text, 0.10));
    s.setProperty("--accent", accentHex);
    s.setProperty("--accent-contrast", lightText ? "#0d1117" : "#ffffff");
    s.setProperty("--overlay", "rgba(" + ac.r + "," + ac.g + "," + ac.b + ",0.12)");
    s.setProperty("--shadow", lightText ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.12)");
    s.setProperty("--page-shadow", lightText ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.18)");
    s.setProperty("--header-bg", "rgba(" + bg.r + "," + bg.g + "," + bg.b + ",0.9)");
    // PDF pages always render as white "paper" regardless of the gutter color.
    s.setProperty("--page-bg", "#ffffff");
    s.colorScheme = lightText ? "dark" : "light";
    themeColor.setAttribute("content", hex);
  }
  function isHex6(v){ return /^#([0-9a-f]{6})$/i.test(v || ""); }
  function saveColor(val){
    setCookie("mykk-bg", val);
    try{ localStorage.setItem("mykk-bg", val); }catch(e){}
  }
  function loadColor(){
    var v = getCookie("mykk-bg");
    if (!isHex6(v)){ try{ v = localStorage.getItem("mykk-bg"); }catch(e){ v = null; } }
    return isHex6(v) ? v : ((window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) ? "#0d1117" : "#ffffff");
  }
  var saved = loadColor();
  bgPicker.value = saved;
  applyColor(saved);
  bgPicker.addEventListener("input", function(){
    applyColor(bgPicker.value);
    saveColor(bgPicker.value);
    syncThemeToggle();
  });
  var themeToggle=document.getElementById("themeToggle"),themeIconSun=document.getElementById("themeIconSun"),themeIconMoon=document.getElementById("themeIconMoon");
  function isDarkBg(){ try { return luminance(hexToRgb(bgPicker.value)) <= 0.179; } catch(e){ return false; } }
  function syncThemeToggle(){ if(!themeToggle) return; var dark=isDarkBg(); themeToggle.setAttribute("aria-pressed", dark?"true":"false"); themeToggle.setAttribute("aria-label", dark?"Switch to light theme":"Switch to dark theme"); if(themeIconSun){ if(dark) themeIconSun.setAttribute("hidden",""); else themeIconSun.removeAttribute("hidden"); } if(themeIconMoon){ if(dark) themeIconMoon.removeAttribute("hidden"); else themeIconMoon.setAttribute("hidden",""); } }
  if(themeToggle){ themeToggle.addEventListener("click", function(){ var next=isDarkBg()?"#ffffff":"#0d1117"; bgPicker.value=next; applyColor(next); saveColor(next); syncThemeToggle(); }); }
  syncThemeToggle();

  /* ---------- Drag & drop (anywhere) ---------- */
  var dragDepth = 0;
  function showOverlay(s){ overlay.classList.toggle("show", s); }
  window.addEventListener("dragenter", function(e){
    if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") === -1) return;
    e.preventDefault(); dragDepth++; showOverlay(true);
  });
  window.addEventListener("dragover", function(e){
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", function(e){
    e.preventDefault(); dragDepth--; if (dragDepth <= 0){ dragDepth = 0; showOverlay(false); }
  });
  window.addEventListener("drop", function(e){
    e.preventDefault(); dragDepth = 0; showOverlay(false);
    var dt = e.dataTransfer; if (!dt) return;
    if (dt.files && dt.files.length) readFile(dt.files[0]);
  });

  /* ---------- Paste a file to open it ---------- */
  window.addEventListener("paste", function(e){
    var cd = e.clipboardData || window.clipboardData;
    if (cd && cd.files && cd.files.length){ e.preventDefault(); readFile(cd.files[0]); }
  });

  /* ---------- Family router (§6.10): a rejected file that belongs to a sibling
     viewer gets an offer card, and an accepted offer hands the File to the new
     tab in the browser (postMessage structured clone — never on the wire). ---------- */
        /* FV-MAP-START — generated from family-map.json (canonical); deep-equality enforced by the harness */
    var FAMILY = {
      audio:    { domain:"audio-viewer.us"     , label:"Audio Viewer"     , kind:"an audio file" },
      cert:     { domain:"cert-viewer.us"      , label:"Cert Viewer"      , kind:"a certificate" },
      data:     { domain:"data-viewer.us"      , label:"Data Viewer"      , kind:"a data file" },
      docx:     { domain:"docx-viewer.us"      , label:"DOCX Viewer"      , kind:"a Word document" },
      eml:      { domain:"eml-viewer.us"       , label:"EML Viewer"       , kind:"an email file" },
      epub:     { domain:"epub-viewer.us"      , label:"EPUB Viewer"      , kind:"an e-book" },
      html:     { domain:"html-viewer.us"      , label:"HTML Viewer"      , kind:"a web or source-code file" },
      image:    { domain:"image-viewer.us"     , label:"Image Viewer"     , kind:"an image" },
      log:      { domain:"log-viewer.us"       , label:"Log Viewer"       , kind:"a log file" },
      markdown: { domain:"markdown-viewer.us"  , label:"Markdown Viewer"  , kind:"a Markdown or text file" },
      pdf:      { domain:"pdf-viewer.us"       , label:"PDF Viewer"       , kind:"a PDF" },
      pptx:     { domain:"pptx-viewer.us"      , label:"PPTX Viewer"      , kind:"a presentation" },
      pub:      { domain:"pub-viewer.us"       , label:"PUB Viewer"       , kind:"a Publisher file" },
      sheets:   { domain:"sheets-viewer.us"    , label:"Sheets Viewer"    , kind:"a spreadsheet" },
      video:    { domain:"video-viewer.us"     , label:"Video Viewer"     , kind:"a video" }
    };
    var FAMILY_HUB = "file-viewer.us";
    var FAMILY_NAMES = {"robots.txt":"html"};
    var FAMILY_MAP = {
      // sheets
      "123":"sheets", xlsx:"sheets", xlsm:"sheets", xlsb:"sheets", xls:"sheets", xlt:"sheets", xltx:"sheets", xltm:"sheets",
      xlam:"sheets", ods:"sheets", fods:"sheets", dif:"sheets", prn:"sheets", dbf:"sheets", numbers:"sheets", xlml:"sheets",
      wk1:"sheets", wk3:"sheets", wks:"sheets", et:"sheets", uos:"sheets",
      // cert
      pem:"cert", crt:"cert", cer:"cert", der:"cert", csr:"cert", cert:"cert", p7b:"cert", p12:"cert",
      pfx:"cert",
      // data
      json:"data", jsonc:"data", json5:"data", jsonld:"data", ndjson:"data", yaml:"data", yml:"data", toml:"data",
      csv:"data", tsv:"data", xml:"data", rss:"data", atom:"data", graphql:"data", gql:"data",
      // docx
      docx:"docx", docm:"docx", dotx:"docx", dotm:"docx", doc:"docx", dot:"docx", rtf:"docx", odt:"docx",
      // eml
      eml:"eml", mbox:"eml", emlx:"eml", msg:"eml",
      // epub
      epub:"epub",
      // html
      html:"html", htm:"html", xhtml:"html", xht:"html", shtml:"html", shtm:"html", stm:"html", hta:"html",
      mhtml:"html", mht:"html", css:"html", scss:"html", sass:"html", less:"html", styl:"html", pcss:"html",
      postcss:"html", js:"html", mjs:"html", cjs:"html", jsx:"html", ts:"html", mts:"html", cts:"html",
      tsx:"html", coffee:"html", htaccess:"html", htpasswd:"html", env:"html", ini:"html", conf:"html", webmanifest:"html",
      map:"html", php:"html", phtml:"html", asp:"html", aspx:"html", ascx:"html", cshtml:"html", vbhtml:"html",
      jsp:"html", jspx:"html", cfm:"html", erb:"html", rhtml:"html", ejs:"html", hbs:"html", handlebars:"html",
      mustache:"html", njk:"html", liquid:"html", jinja:"html", j2:"html", twig:"html", pug:"html", jade:"html",
      haml:"html", slim:"html", vue:"html", svelte:"html", astro:"html",
      // image
      png:"image", jpg:"image", jpeg:"image", jpe:"image", jfif:"image", gif:"image", webp:"image", avif:"image",
      svg:"image", svgz:"image", bmp:"image", dib:"image", ico:"image", cur:"image", tif:"image", tiff:"image",
      tga:"image", targa:"image", icb:"image", vda:"image", vst:"image", qoi:"image", pcx:"image", ppm:"image",
      pgm:"image", pbm:"image", pnm:"image", pam:"image", ff:"image", dds:"image", heic:"image", heif:"image",
      jxl:"image", psd:"image",
      // log
      log:"log", out:"log", err:"log", trace:"log", syslog:"log",
      // markdown
      md:"markdown", markdown:"markdown", mdx:"markdown", txt:"markdown", rst:"markdown", adoc:"markdown",
      // pdf
      pdf:"pdf",
      // pptx
      pptx:"pptx", pptm:"pptx", ppsx:"pptx", ppsm:"pptx", potx:"pptx", potm:"pptx", ppt:"pptx",
      // pub
      pub:"pub",
      // audio
      mp3:"audio", wav:"audio", flac:"audio", m4a:"audio", aac:"audio", ogg:"audio", oga:"audio", opus:"audio",
      weba:"audio", mka:"audio", aif:"audio", aiff:"audio", wma:"audio", mid:"audio", midi:"audio",
      // video
      webm:"video", mp4:"video", m4v:"video", ogv:"video", mov:"video", mkv:"video", avi:"video", wmv:"video"
    };
    /* FV-MAP-END */
    var FAMILY_ORIGINS = Object.keys(FAMILY).map(function (k) { return "https://" + FAMILY[k].domain; })
      .concat("https://" + FAMILY_HUB);
  var DOMAIN = "pdf-viewer.us";
  function id(s){ return doc.getElementById(s); }

  var routeFile = null, routeKey = "", routePrevFocus = null, handoff = null;
  function cancelHandoff(){                    // tear down a pending hand-off (sender below)
    if (!handoff) return;
    window.removeEventListener("message", handoff.onMsg);
    clearTimeout(handoff.timer);
    handoff = null;
  }
  function showRouteCard(file, key){
    cancelHandoff();                           // a new offer aborts any pending hand-off
    if (id("routeCard").hidden) routePrevFocus = doc.activeElement;  // don't capture our own button
    routeFile = file; routeKey = key;
    var t = FAMILY[key];
    // ⁨…⁩ (FSI…PDI) bidi-isolate the untrusted name so U+202E-style
    // overrides can't visually reorder the sentence.
    id("routeMsg").textContent = "“⁨" + file.name + "⁩” looks like " + t.kind + " — it belongs to " + t.label + ".";
    id("routeGo").textContent = "Open " + t.domain + " ↗";
    id("routeSub").textContent = "Your file stays on this device — nothing is uploaded.";
    id("routeGo").disabled = false;
    id("routeBackdrop").hidden = false; id("routeCard").hidden = false;
    id("routeGo").focus();
  }
  function hideRouteCard(){
    cancelHandoff();                           // dismissal aborts a pending hand-off
    id("routeBackdrop").hidden = true; id("routeCard").hidden = true;
    routeFile = null; routeKey = "";
    if (routePrevFocus && routePrevFocus.focus) routePrevFocus.focus();
  }
  function familyRoute(file){
    var n = String(file && file.name || "").toLowerCase();
    var key = FAMILY_NAMES[n];
    if (!key){
      var i = n.lastIndexOf(".");
      var ext = i >= 0 ? n.slice(i + 1) : "";
      key = FAMILY_MAP[ext];
    }
    if (!key || FAMILY[key].domain === DOMAIN) return false;  // unknown type, or our own → caller keeps its toast
    showRouteCard(file, key);
    return true;
  }

  // Sender — a real user gesture, so no popup blocker. Keep the window handle:
  // no `noopener` on this one window.open — the handle is the message channel.
  id("routeGo").addEventListener("click", function(){
    if (!routeFile || id("routeGo").disabled) return;               // no double-fire
    cancelHandoff();
    var t = FAMILY[routeKey], origin = "https://" + t.domain, file = routeFile;
    var w = window.open(origin + "/#fvh=" + encodeURIComponent(file.name));
    if (!w){ id("routeSub").textContent = "Couldn’t open the tab — allow pop-ups for this site and try again."; return; }
    id("routeGo").disabled = true;
    var h = {};
    h.onMsg = function(e){
      if (e.source !== w || e.origin !== origin || !e.data) return;
      if (e.data.type === "fv-ready") w.postMessage({ type:"fv-file", file:file }, origin);
      else if (e.data.type === "fv-ack"){ hideRouteCard(); toast("Sent to " + t.label); }  // hideRouteCard tears the handshake down
    };
    h.timer = setTimeout(function(){
      if (handoff !== h) return;
      cancelHandoff();
      id("routeSub").textContent = "Tab opened — drop the file there.";   // Level-1 fallback
    }, 10000);
    handoff = h;
    window.addEventListener("message", h.onMsg);
  });
  id("routeDismiss").addEventListener("click", hideRouteCard);
  id("routeBackdrop").addEventListener("click", hideRouteCard);

  // Receiver — a sibling tab (hub or viewer) hands a File over via postMessage.
  window.addEventListener("message", function(e){
    if (FAMILY_ORIGINS.indexOf(e.origin) === -1) return;      // family origins only
    var d = e.data;
    if (d && d.type === "fv-file" && d.file instanceof File){ // clone re-creates a real File in this realm
      readFile(d.file);
      e.source.postMessage({ type:"fv-ack" }, e.origin);      // ack = received and handed to the loader
    }
  });
  var fvh = /[#&]fvh=([^&]*)/.exec(location.hash);
  if (fvh){
    var fvhName = fvh[1];
    try{ fvhName = decodeURIComponent(fvh[1]); }catch(_){}    // stranger-controlled — a bad %-escape must not stop the hash clearing below
    history.replaceState(null, "", location.pathname + location.search);  // always clear, opener or not
    if (window.opener){
      try{ window.opener.postMessage({ type:"fv-ready" }, "*"); }catch(_){}
      window.opener = null;    // sever the reverse-navigation channel once the ping is out
      var emptySub = empty.querySelector(".empty-sub");
      if (emptySub){
        var emptySubText = emptySub.textContent;              // fvhName is untrusted — textContent only, bidi-isolated
        emptySub.textContent = "Receiving “⁨" + fvhName + "⁩”…";
        setTimeout(function(){ emptySub.textContent = emptySubText; }, 10000);
      }
    }
  }
  // A bookmarked or shared link can carry the name of the file last viewed
  // (?name=, set by syncQueryName above). No content is ever recoverable
  // from a name alone -- this only labels the empty state, and it never
  // fetches or renders anything on the strength of it. Skipped when an
  // #fvh hand-off is already customizing the same element.
  if (!fvh && !pdfDoc){
    var qName = new URLSearchParams(location.search).get("name");
    if (qName){
      var lastSub = doc.querySelector(".empty-sub");
      if (lastSub){
        // Display-only, and it must stay that way: this string is read
        // straight from the URL, so it is exactly as stranger-controlled as
        // fvhName above. No fact is asserted about whether anyone actually
        // viewed it -- only that the link names it.
        lastSub.textContent = "This link was shared for “⁨" + qName + "⁩”.";
      }
    }
  }


  if (!pdfjsLib) toast("Viewer failed to load its PDF engine");
})();
