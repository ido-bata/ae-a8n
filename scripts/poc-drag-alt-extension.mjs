// Consumer extension module for scripts/poc-drag-alt.mjs (#411 PoC).
// Build with: node dist/cli.js extension build --extension <this file> --out <host.jsx>
// Method sources are ES3 function expressions run inside After Effects.
// Superset of scripts/poc-drag-extension.mjs (#369) plus openInViewer.
export default {
  name: "a8n-drag-alt-poc",
  version: "0.1.0",
  methods: [
    {
      // Read-only project inventory IN PANEL ORDER: the oracle for
      // "did the drop/reorder land" (app.project.item(i) follows the
      // Project panel order).
      name: "poc.projectItems",
      source:
        "function (params) {" +
        " var out = [];" +
        " try {" +
        "  var n = app.project.numItems;" +
        "  for (var i = 1; i <= n; i++) {" +
        "   var it = app.project.item(i);" +
        "   var t = '';" +
        "   try { t = String(it.type); } catch (e) {}" +
        "   out.push({ id: it.id, name: it.name, type: t });" +
        "  }" +
        " } catch (e) { return { error: String(e) }; }" +
        " return { count: out.length, items: out };" +
        " }",
    },
    {
      // Idempotent fixture: a comp named params.name (default "PoC Comp")
      // with named solids, so element drags have visible rows/layers and
      // project items to reorder. Scripting is SETUP only — never drop
      // evidence. Three project items result (comp + 2 solids).
      name: "poc.ensureComp",
      source:
        "function (params) {" +
        " var name = (params && params.name) ? params.name : 'PoC Comp';" +
        " var found = null;" +
        " try {" +
        "  for (var i = 1; i <= app.project.numItems; i++) {" +
        "   var it = app.project.item(i);" +
        "   if (it instanceof CompItem && it.name === name) { found = it; break; }" +
        "  }" +
        " } catch (e) {}" +
        " if (found === null) {" +
        "  found = app.project.items.addComp(name, 320, 240, 1.0, 10, 30);" +
        " }" +
        " var layers = [];" +
        " try {" +
        "  if (found.numLayers === 0) {" +
        "   found.layers.addSolid([1, 0, 0], 'PoC Solid A', 160, 120, 1.0);" +
        "   found.layers.addSolid([0, 0, 1], 'PoC Solid B', 160, 120, 1.0);" +
        "   found.layers.addSolid([0, 1, 0], 'PoC Solid C', 160, 120, 1.0);" +
        "  }" +
        "  for (var j = 1; j <= found.numLayers; j++) {" +
        "   var ly = found.layer(j);" +
        "   layers.push({ index: j, name: ly.name });" +
        "  }" +
        " } catch (e) { return { error: String(e), comp: found.name }; }" +
        " return { comp: found.name, id: found.id, layers: layers };" +
        " }",
    },
    {
      // Layer order readback for the in-app layer-drag oracle.
      name: "poc.compLayers",
      source:
        "function (params) {" +
        " var name = (params && params.name) ? params.name : 'PoC Comp';" +
        " try {" +
        "  for (var i = 1; i <= app.project.numItems; i++) {" +
        "   var it = app.project.item(i);" +
        "   if (it instanceof CompItem && it.name === name) {" +
        "    var out = [];" +
        "    for (var j = 1; j <= it.numLayers; j++) {" +
        "     out.push({ index: j, name: it.layer(j).name });" +
        "    }" +
        "    return { comp: it.name, layers: out };" +
        "   }" +
        "  }" +
        " } catch (e) { return { error: String(e) }; }" +
        " return { error: 'comp not found', name: name };" +
        " }",
    },
    {
      // Open a fresh untitled project when none exists (home screen).
      name: "poc.ensureProject",
      source:
        "function (params) {" +
        " try {" +
        "  if (app.project === null) { app.newProject(); }" +
        "  return { file: app.project.file ? String(app.project.file) : null, items: app.project.numItems };" +
        " } catch (e) { return { error: String(e) }; }" +
        " }",
    },
    {
      // Open the named comp in its viewer (CompItem.openInViewer) so the
      // Timeline pane has a comp to show layer rows for. Setup only.
      name: "poc.openCompInViewer",
      source:
        "function (params) {" +
        " var name = (params && params.name) ? params.name : 'PoC Comp';" +
        " try {" +
        "  for (var i = 1; i <= app.project.numItems; i++) {" +
        "   var it = app.project.item(i);" +
        "   if (it instanceof CompItem && it.name === name) {" +
        "    it.openInViewer();" +
        "    return { opened: it.name, id: it.id };" +
        "   }" +
        "  }" +
        " } catch (e) { return { error: String(e) }; }" +
        " return { error: 'comp not found', name: name };" +
        " }",
    },
  ],
};
