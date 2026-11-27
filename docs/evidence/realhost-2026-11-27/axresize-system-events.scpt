on run argv
  set targetPid to (item 1 of argv) as integer
  set newW to (item 2 of argv) as integer
  set newH to (item 3 of argv) as integer
  with timeout of 20 seconds
    tell application "System Events"
      set procs to (every application process whose unix id is targetPid)
      if (count of procs) is 0 then return "MISSING"
      set p to item 1 of procs
      set fw to value of attribute "AXFocusedWindow" of p
      if fw is missing value then return "NO-FOCUSED-WINDOW"
      set b4 to ""
      try
        set bp to position of fw
        set bs to size of fw
        set b4 to (item 1 of bp as string) & "," & (item 2 of bp as string) & " " & (item 1 of bs as string) & "x" & (item 2 of bs as string)
      end try
      try
        set size of fw to {newW, newH}
      on error errMsg
        return "SET-FAIL b4=" & b4 & " err=" & errMsg
      end try
      delay 0.5
      set aft to ""
      try
        set ap to position of fw
        set ah to size of fw
        set aft to (item 1 of ap as string) & "," & (item 2 of ap as string) & " " & (item 1 of ah as string) & "x" & (item 2 of ah as string)
      end try
      return "RESIZED b4=" & b4 & " aft=" & aft
    end tell
  end timeout
end run
