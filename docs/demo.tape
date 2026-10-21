# Records docs/demo.gif with https://github.com/charmbracelet/vhs:  vhs docs/demo.tape
# The sessions are synthetic (scripts/demo.js runs the real CLI on made-up data).

Output docs/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1360
Set Height 600
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type `export PS1='$ '; agents-top() { node scripts/demo.js "$@"; }; clear`
Enter
Show

Type "agents-top"
Sleep 400ms
Enter
Sleep 5s

Type "agents-top --json | jq -c '.claude.sessions[] | {pid, state, possiblePermissionPrompt}'"
Sleep 400ms
Enter
Sleep 4s

Type "clear; agents-top -w 1"
Sleep 400ms
Enter
Sleep 4s
Type "q"
Sleep 800ms
