-- Pikmin GPS.app launcher: starts the bundled bridge in the background (if not already running)
-- and opens the control page. The bridge keeps running after this applet quits; stop it from the
-- web page (裝置 → 結束電腦端程式).
on run
	set res to POSIX path of (path to me) & "Contents/Resources/"
	set pageURL to "http://127.0.0.1:8787/"
	set isUp to my bridgeUp(pageURL)
	if not isUp then
		set nodeArm to quoted form of (res & "node-arm64/node")
		set nodeX64 to quoted form of (res & "node-x64/node")
		set cmd to "cd " & quoted form of (res & "app/server") & " && " & ¬
			"if [ \"$(uname -m)\" = arm64 ]; then N=" & nodeArm & "; else N=" & nodeX64 & "; fi; " & ¬
			"mkdir -p \"$HOME/Library/Logs/PikminGPS\"; " & ¬
			"nohup \"$N\" src/server.js > \"$HOME/Library/Logs/PikminGPS/bridge.log\" 2>&1 &"
		do shell script cmd
		repeat 30 times
			delay 0.3
			if my bridgeUp(pageURL) then
				set isUp to true
				exit repeat
			end if
		end repeat
	end if
	if isUp then
		open location pageURL
	else
		display dialog "電腦端程式啟動失敗。" & return & "記錄檔：~/Library/Logs/PikminGPS/bridge.log" buttons {"好"} default button 1 with icon caution
	end if
end run

on bridgeUp(u)
	try
		do shell script "/usr/bin/curl -s -o /dev/null -m 1 " & quoted form of u
		return true
	on error
		return false
	end try
end bridgeUp
