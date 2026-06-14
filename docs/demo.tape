# Render with: vhs docs/demo.tape   (from the velve repo root)
Output "docs/demo.gif"

Set Shell "bash"
Set FontSize 19
Set Width 1180
Set Height 640
Set Padding 22
Set Theme "Catppuccin Mocha"

Hide
Type "cd /home/velasco/workspaces/velve/checker" Enter
Type "export NODE_NO_WARNINGS=1; shopt -s expand_aliases; alias velve='node dist/index.js'" Enter
Type "clear" Enter
Show

Type "# A colour that fails contrast is a type error, not a lint note:" Sleep 600ms Enter
Sleep 700ms
Type "velve check accessibility_bad.velve" Sleep 500ms Enter
Sleep 2800ms

Type "# Refinement types, checked where untrusted data enters:" Sleep 600ms Enter
Sleep 700ms
Type "velve run refinement_test.velve" Sleep 500ms Enter
Sleep 3200ms
