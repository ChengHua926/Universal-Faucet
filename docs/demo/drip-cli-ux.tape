Output docs/demo/drip-cli-ux.gif

Set Shell "zsh"
Set FontSize 16
Set Width 1040
Set Height 720
Set TypingSpeed 45ms
Set Theme "Catppuccin Mocha"

Type "export DRIP_HOME=/private/tmp/drip-cli-ux-demo"
Enter
Sleep 1s

Type "./target/debug/drip --help"
Enter
Sleep 7s

Type "clear"
Enter
Sleep 1s

Type "./target/debug/drip base-sepolia eth 0x111"
Enter
Sleep 6s

Type "clear"
Enter
Sleep 1s

Type "./target/debug/drip status"
Enter
Sleep 6s
