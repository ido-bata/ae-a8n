/*
 * Issue #98: read-only, explicitly activated AE-side polling proof.
 * Node does NOT send an Apple Event for each ping. No project mutations,
 * dynamic user code, quit operation, network server or automatic TCC grant.
 * This experiment is not a supported production transport.
 */
(function () {
  var root = new Folder(__A8N_PROOF_ROOT__);
  var token = __A8N_PROOF_TOKEN__;
  var inbox = new Folder(root.fsName + "/inbox");
  var outbox = new Folder(root.fsName + "/outbox");
  var codec = $.evalFile(new File(root.fsName + "/a8n-json.js"));
  if (!codec || typeof codec.parse !== "function" || typeof codec.stringify !== "function") {
    throw new Error("ae-a8n proof: JSON codec is unavailable");
  }
  if (!inbox.exists || !outbox.exists) {
    throw new Error("ae-a8n proof: channel folders are missing");
  }
  if ($.global.__a8nInprocessProofTask !== undefined) {
    throw new Error("ae-a8n proof is already active; no duplicate dispatcher");
  }

  function readText(file) {
    file.encoding = "UTF-8";
    if (!file.open("r")) {
      throw new Error("cannot read request");
    }
    var result = file.read();
    file.close();
    return result;
  }

  function publish(name, value) {
    var part = new File(outbox.fsName + "/" + name + ".part");
    part.encoding = "UTF-8";
    if (!part.open("w")) {
      throw new Error("cannot open response temp file");
    }
    part.write(codec.stringify(value));
    part.close();
    if (!part.rename(name)) {
      // Failure remains UNKNOWN to Node; never publish a partial response.
      part.remove();
      throw new Error("cannot publish response atomically");
    }
  }

  function tick() {
    try {
      var files = inbox.getFiles("*.request.json");
      var count = Math.min(files.length, 4);
      for (var i = 0; i < count; i++) {
        var f = files[i];
        if (!(f instanceof File)) {
          continue;
        }
        var match = /^([0-9a-f]{32})\.request\.json$/.exec(f.name);
        if (!match) {
          continue;
        }
        var id = match[1];
        // Claim-before-run. A host restart cannot replay a claimed operation.
        var claimName = id + ".claimed";
        if (!f.rename(claimName)) {
          continue;
        }
        var claimed = new File(inbox.fsName + "/" + claimName);
        var reply = { v: 1, id: id, token: token, ok: false, message: "refused" };
        try {
          var request = codec.parse(readText(claimed));
          var now = new Date().getTime();
          if (!request || request.v !== 1 || request.id !== id ||
              request.token !== token || request.method !== "app.version" ||
              typeof request.deadlineMs !== "number" ||
              request.deadlineMs < now || request.deadlineMs > now + 30000) {
            throw new Error("unauthorized, expired or unknown request");
          }
          reply = { v: 1, id: id, token: token, ok: true, aeVersion: String(app.version) };
        } catch (failure) {
          reply.message = "request refused";
        }
        try {
          publish(id + ".result.json", reply);
        } catch (publishError) {
          // The caller times out UNKNOWN; do not retry a claimed request.
        }
        claimed.remove();
      }
    } catch (error) {
      // A scheduled task must not raise a modal dialog while the user works.
      // With no response the caller reports UNKNOWN rather than success.
    }
  }

  // The static string contains no user-supplied code or external file path.
  $.global.__a8nInprocessProofTick = tick;
  $.global.__a8nInprocessProofTask = app.scheduleTask("$.global.__a8nInprocessProofTick()", 250, true);
})();
