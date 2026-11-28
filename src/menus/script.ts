/**
 * AppleScript vehicles for the macOS menu-bar surface (#360).
 *
 * Both scripts run inside the target session via `osascript`, the same
 * transport `LIST_WINDOWS_SCRIPT`/`PRESS_BUTTON_SCRIPT` use — nothing
 * here is spliced into source; every value arrives as `argv`.
 *
 * System Events exposes the menu bar as `menu bar 1` → `menu bar items`
 * → `menu 1` → `menu items`, and a `menu item`'s submenu as `menu 1 of
 * that item`. Menu state arrives through accessibility attributes:
 * `AXEnabled`, `AXMenuItemMarkChar` (the checkmark), `AXMenuItemCmdChar`
 * and `AXMenuItemCmdModifiers` (the shortcut). Whether After Effects
 * vends all of these faithfully is **unverified on a real host** — the
 * contract records `unknown`/null rather than guessing.
 */

/**
 * Lists the process's menu bar tree.
 *
 * Output protocol (one record per line, `|`-separated; every label is
 * passed through `a8nClean` so a title can never split a record):
 *
 *   MB|<menuBarItemIndex>|<title>|<role>|<enabled>
 *   I|<indexPath csv>|<title>|<role>|<enabled>|<checked>|<mark>|<shortcut>|<kind>
 *   TRUNCATED|1
 *
 * `indexPath` is 1-based: the first element is the menu bar item's
 * position, each following element the item's position inside its parent
 * menu. `enabled`/`checked` are "1"/"0"/"-" where "-" means the
 * attribute could not be read. `kind` is `item`, `separator` (empty
 * title, no children) or `submenu`.
 *
 *   argv: pid
 *
 * Prints MISSING / NOMENUBAR / the listing.
 */
export const LIST_MENU_BAR_SCRIPT = [
  "on run argv",
  "  set targetPid to (item 1 of argv) as integer",
  "  set maxItems to 200",
  "  set maxDepth to 8",
  "  tell application \"System Events\"",
  "    set procs to (every application process whose unix id is targetPid)",
  "    if (count of procs) is 0 then return \"MISSING\"",
  "    set p to item 1 of procs",
  "    set mbs to {}",
  "    try",
  "      set mbs to menu bar items of menu bar 1 of p",
  "    on error",
  "      return \"NOMENUBAR\"",
  "    end try",
  "    set lines to {}",
  "    set mbiIdx to 0",
  "    repeat with mbi in mbs",
  "      set mbiIdx to mbiIdx + 1",
  "      set mtitle to \"\"",
  "      try",
  "        set mtitle to (name of mbi) as string",
  "      end try",
  "      set mrole to \"\"",
  "      try",
  "        set mrole to (role of mbi) as string",
  "      end try",
  "      set menabled to \"\"",
  "      try",
  "        set menabled to my a8nFlag(value of attribute \"AXEnabled\" of mbi)",
  "      end try",
  "      set end of lines to \"MB|\" & mbiIdx & \"|\" & my a8nClean(mtitle) & \"|\" & mrole & \"|\" & menabled",
  "      set mitems to {}",
  "      try",
  "        set mitems to menu items of menu 1 of mbi",
  "      on error",
  "        set mitems to {}",
  "      end try",
  "      set walked to my a8nWalkMenu(mitems, {mbiIdx}, 1, maxItems, maxDepth)",
  "      set lines to lines & (item 1 of walked)",
  "      if (item 2 of walked) is true then set end of lines to \"TRUNCATED|1\"",
  "    end repeat",
  "  end tell",
  "  set AppleScript's text item delimiters to linefeed",
  "  return lines as string",
  "end run",
  // Walks one menu's items, emitting `I|` records and recursing into
  // submenus. Returns {lines, truncated}: AppleScript has no out
  // parameters, so the accumulator travels in the return value.
  "on a8nWalkMenu(itemList, pathPrefix, depth, maxItems, maxDepth)",
  "  set outLines to {}",
  "  set truncated to false",
  "  set i to 0",
  "  repeat with mi in itemList",
  "    set i to i + 1",
  "    if i > maxItems then",
  "      set truncated to true",
  "      exit repeat",
  "    end if",
  // `attribute`, `name of`, `menu items of` are System Events suite
  // terms: outside a `tell` they do not even parse (osacompile
  // -2741), so every element read happens inside one.
  "    tell application \"System Events\"",
  "    set ititle to \"\"",
  "    try",
  "      set ititle to (name of mi) as string",
  "    end try",
  "    set irole to \"\"",
  "    try",
  "      set irole to (role of mi) as string",
  "    end try",
  "    set ienabled to \"\"",
  "    try",
  "      set ienabled to my a8nFlag(value of attribute \"AXEnabled\" of mi)",
  "    end try",
  "    set icheck to \"-\"",
  "    set imark to \"\"",
  "    try",
  "      set mv to value of attribute \"AXMenuItemMarkChar\" of mi",
  "      if mv is not missing value then",
  "        set imark to my a8nClean(mv as string)",
  "        if imark is \"\" then",
  "          set icheck to \"0\"",
  "        else",
  "          set icheck to \"1\"",
  "        end if",
  "      end if",
  "    on error",
  "      set icheck to \"-\"",
  "      set imark to \"\"",
  "    end try",
  "    set ishortcut to \"\"",
  "    try",
  "      set sc to value of attribute \"AXMenuItemCmdChar\" of mi",
  "      if sc is not missing value then set ishortcut to my a8nClean(sc as string)",
  "    end try",
  "    try",
  "      set sm to value of attribute \"AXMenuItemCmdModifiers\" of mi",
  "      if sm is not missing value then set ishortcut to ishortcut & \":\" & (sm as string)",
  "    end try",
  "    set subItems to {}",
  "    set hasSubmenu to false",
  "    try",
  "      set subItems to menu items of menu 1 of mi",
  "      if (count of subItems) > 0 then set hasSubmenu to true",
  "    on error",
  "      set subItems to {}",
  "      set hasSubmenu to false",
  "    end try",
  "    end tell",
  "    set pathList to pathPrefix & {i}",
  "    set pathStr to my a8nJoin(pathList, \",\")",
  "    set cleanTitle to my a8nClean(ititle)",
  "    if hasSubmenu then",
  "      set end of outLines to \"I|\" & pathStr & \"|\" & cleanTitle & \"|\" & irole & \"|\" & ienabled & \"|\" & icheck & \"|\" & imark & \"|\" & ishortcut & \"|submenu\"",
  "      if depth < maxDepth then",
  "        set subWalked to my a8nWalkMenu(subItems, pathList, depth + 1, maxItems, maxDepth)",
  "        set outLines to outLines & (item 1 of subWalked)",
  "        if (item 2 of subWalked) is true then set truncated to true",
  "      else",
  "        set truncated to true",
  "      end if",
  "    else if cleanTitle is \"\" then",
  "      set end of outLines to \"I|\" & pathStr & \"||\" & irole & \"|\" & ienabled & \"|\" & icheck & \"|\" & imark & \"|\" & ishortcut & \"|separator\"",
  "    else",
  "      set end of outLines to \"I|\" & pathStr & \"|\" & cleanTitle & \"|\" & irole & \"|\" & ienabled & \"|\" & icheck & \"|\" & imark & \"|\" & ishortcut & \"|item\"",
  "    end if",
  "  end repeat",
  "  return {outLines, truncated}",
  "end a8nWalkMenu",
  "on a8nFlag(v)",
  "  try",
  "    if v is true then return \"1\"",
  "    if v is false then return \"0\"",
  "  end try",
  "  return \"\"",
  "end a8nFlag",
  "on a8nJoin(theList, delim)",
  "  set AppleScript's text item delimiters to delim",
  "  set s to theList as string",
  "  set AppleScript's text item delimiters to \" \"",
  "  return s",
  "end a8nJoin",
  // One line per field: the listing is line-based, so a line break inside
  // a label would split it into two records. `|` is folded too, so the
  // field layout cannot shift — same rule as the window listing.
  "on a8nClean(s)",
  "  set AppleScript's text item delimiters to {return, linefeed, \"|\"}",
  "  set parts to text items of s",
  "  set AppleScript's text item delimiters to \" \"",
  "  return parts as string",
  "end a8nClean",
];

/**
 * Presses one menu item, addressed by the index path and the titles the
 * resolution observed — never by remembered coordinates.
 *
 * The script re-walks the tree inside the target session and verifies
 * every level's title against `expectedTitles` before clicking, so a
 * menu that changed between the listing and the press is refused
 * (`CHANGED`), not clicked blindly. This is the in-session half of the
 * spec §6 re-resolution rule; the caller re-resolves before calling.
 *
 *   argv: pid, indexPath "1,3,2", expectedTitles "Window|Workspace|Standard"
 *
 * Prints CLICKED / NOT_FOUND / CHANGED / FAILED / MISSING / NOMENUBAR.
 * `FAILED` means the press itself errored after every identity check
 * passed — an unknown outcome, surfaced as indeterminate upstream.
 */
export const INVOKE_MENU_ITEM_SCRIPT = [
  "on run argv",
  "  set targetPid to (item 1 of argv) as integer",
  "  set indexPath to item 2 of argv",
  "  set expectedTitles to item 3 of argv",
  "  tell application \"System Events\"",
  "    set procs to (every application process whose unix id is targetPid)",
  "    if (count of procs) is 0 then return \"MISSING\"",
  "    set p to item 1 of procs",
  "    set mbs to {}",
  "    try",
  "      set mbs to menu bar items of menu bar 1 of p",
  "    on error",
  "      return \"NOMENUBAR\"",
  "    end try",
  "    set AppleScript's text item delimiters to \",\"",
  "    set idxs to text items of indexPath",
  "    set AppleScript's text item delimiters to \"|\"",
  "    set titles to text items of expectedTitles",
  "    set AppleScript's text item delimiters to \" \"",
  "    if (count of idxs) < 2 then return \"CHANGED\"",
  "    if (count of titles) is not (count of idxs) then return \"CHANGED\"",
  "    set mbiIdx to (item 1 of idxs) as integer",
  "    if mbiIdx < 1 then return \"CHANGED\"",
  "    if mbiIdx > (count of mbs) then return \"NOT_FOUND\"",
  "    set cur to item mbiIdx of mbs",
  "    set curTitle to \"\"",
  "    try",
  "      set curTitle to (name of cur) as string",
  "    end try",
  "    if my a8nClean(curTitle) is not (item 1 of titles) then return \"CHANGED\"",
  // Descend: each remaining index picks a menu item out of the current
  // element's menu. The last index is the item to press.
  "    repeat with d from 2 to (count of idxs)",
  "      set kids to {}",
  "      try",
  "        set kids to menu items of menu 1 of cur",
  "      on error",
  "        return \"NOT_FOUND\"",
  "      end try",
  "      set itemIdx to (item d of idxs) as integer",
  "      if itemIdx < 1 then return \"CHANGED\"",
  "      if itemIdx > (count of kids) then return \"NOT_FOUND\"",
  "      set cur to item itemIdx of kids",
  "      set curTitle to \"\"",
  "      try",
  "        set curTitle to (name of cur) as string",
  "      end try",
  "      if my a8nClean(curTitle) is not (item d of titles) then return \"CHANGED\"",
  "    end repeat",
  "    try",
  "      click cur",
  "      return \"CLICKED\"",
  "    on error",
  "      try",
  "        perform action \"AXPress\" of cur",
  "        return \"CLICKED\"",
  "      on error",
  "        return \"FAILED\"",
  "      end try",
  "    end try",
  "  end tell",
  "  return \"NOT_FOUND\"",
  "end run",
  "on a8nClean(s)",
  "  set AppleScript's text item delimiters to {return, linefeed, \"|\"}",
  "  set parts to text items of s",
  "  set AppleScript's text item delimiters to \" \"",
  "  return parts as string",
  "end a8nClean",
];
