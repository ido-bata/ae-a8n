on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set procs to (every application process whose unix id is targetPid)
    if (count of procs) is 0 then return "MISSING"
    set p to item 1 of procs
    set wc to count of windows of p
    set uic to count of UI elements of p
    set wincount to 0
    set roles to ""
    repeat with e in UI elements of p
      try
        set r to (role of e) as string
        set roles to roles & r & ","
        if r is "AXLayoutArea" or r is "AXSheet" or r is "AXDialog" or r is "AXSystemDialog" or r is "AXWindow" then set wincount to wincount + 1
      end try
    end repeat
    set fmostVal to "unknown"
    try
      set fmostVal to frontmost of p
    end try
    set visVal to "unknown"
    try
      set visVal to visible of p
    end try
    return "windowsClass=" & wc & " uiElements=" & uic & " windowRoles=" & wincount & " frontmost=" & fmostVal & " visible=" & visVal & " roles=" & roles
  end tell
end run
