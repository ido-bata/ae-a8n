// Consumer extension module for scripts/poc-panel-mutation.mjs (#357 PoC).
// Build with: node dist/cli.js extension build --extension <this file> --out <host.jsx>
// Method sources are ES3 function expressions run inside After Effects.
export default {
  name: "a8n-panel-poc",
  version: "0.1.0",
  methods: [
    {
      name: "poc.panelShow",
      source:
        "function (params) {" +
        " var w = params && params.width ? params.width : 400;" +
        " var h = params && params.height ? params.height : 300;" +
        " if ($.global.pocPanelWin !== undefined) { try { $.global.pocPanelWin.close(); } catch (e) {} }" +
        " var win = new Window('palette', 'ae-a8n PoC Panel', undefined, {resizeable: true});" +
        " win.orientation = 'column';" +
        " win.add('statictext', undefined, 'ae-a8n panel mutation PoC (#357)');" +
        " win.layout.layout(true);" +
        " win.size = [w, h];" +
        " win.location = [120, 120];" +
        " win.show();" +
        " $.global.pocPanelWin = win;" +
        " return { size: win.size, bounds: win.bounds, location: win.location };" +
        " }",
    },
    {
      name: "poc.panelInfo",
      source:
        "function (params) {" +
        " var win = $.global.pocPanelWin;" +
        " if (win === undefined) return { open: false };" +
        " try { return { open: true, size: win.size, bounds: win.bounds, location: win.location }; }" +
        " catch (e) { return { open: false, error: String(e) }; }" +
        " }",
    },
    {
      name: "poc.panelClose",
      source:
        "function (params) {" +
        " var win = $.global.pocPanelWin;" +
        " if (win !== undefined) { try { win.close(); } catch (e) {} $.global.pocPanelWin = undefined; }" +
        " return { closed: true };" +
        " }",
    },
  ],
};
