// Verification-only: ends the After Effects instance the failed acceptance run
// left behind (pid recorded by Get-Process at 2026-11-10 23:30:01, the only
// AfterFX.exe, none before the run). A normal quit, never a kill: if the
// project has unsaved changes it reports them and leaves AE running.
//
// Run with:  AfterFX.exe -r quit-ae.jsx

(function () {
  var DIR = "C:/Users/rebui/AppData/Local/Temp/a8n-diag-20261110T2345Z";
  var lines = [];

  function describe(error) {
    try {
      return error !== null && error !== undefined && error.message !== undefined
        ? String(error.message)
        : String(error);
    } catch (ignored) {
      return "<unprintable>";
    }
  }

  function writeText(path, text) {
    var file = new File(path);
    file.encoding = "UTF-8";
    if (!file.open("w")) { return false; }
    file.write(text);
    file.close();
    return true;
  }

  try {
    lines.push("app.version = " + String(app.version));
    var project = app.project;
    var file = project !== null && project !== undefined ? project.file : null;
    lines.push("project.file = " + (file === null || file === undefined ? "<none>" : file.fsName));
    lines.push("project.dirty = " + String(project !== null && project !== undefined ? project.dirty : "?"));
    if (file !== null && file !== undefined) {
      lines.push("refused: a project file is open; a person must decide what to save");
    } else if (project !== null && project !== undefined && project.dirty) {
      lines.push("refused: the open project has unsaved changes");
    } else {
      lines.push("quitting");
      writeText(DIR + "/quit.txt", lines.join("\n") + "\n");
      app.quit();
      lines.push("app.quit returned");
    }
  } catch (error) {
    lines.push("threw: " + describe(error));
  }

  writeText(DIR + "/quit.txt", lines.join("\n") + "\n");
})();
