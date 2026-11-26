# Manual test: real calls (about 10 minutes)

Run this on a phone with the installed app after changes to the coach, listening or offline code. It uses a few minutes of ElevenLabs credits. Settings → *Coach minutes per day* must leave at least 5 minutes.

1. **Key test.** Settings → paste the key → *Save and test*. Expect "Key works ✓" and the credit meter. The field is then empty and shows "Key saved · ends in XXXX". With a key without *User: read* you should see "Key works for calls" plus a hint about credits. *Save and test* with an empty field tests the saved key and keeps it.
2. **Short scene (2 min).** Speak → any scene. The coach should greet you within a few seconds. Talk for about two minutes, then *End call*. Expect the recap ("Bravo!"), the minutes added to Speaking and the call counted in Settings → "Today: N min".
3. **Next card.** Speak → Conversation cards → 10 cards. After the first answer tap *Next card*. The coach must read the new card aloud within a few seconds. With subtitles on, no `[APP]` text may appear. End the call.
4. **End while connecting.** Start a scene and tap *End call* straight away, before the coach speaks. Expect "Call cancelled", back on the scene list, no recap, and no new call in the usage numbers. Wait 10 seconds: no voice may start.
5. **Second call refused.** Start a call on the phone, then start one on a laptop (or a second tab). The second one must show a clear message (another call is still running) and go back, with no recap. End the first call.
6. **Leave mid-call.** During a call, swipe back or tap a tab link. A bar "Call in progress · Return · End" must show on every screen. *Return* goes back to the call; *End* ends it and opens the recap.
7. **New listening clip.** Listen → a clip you haven't played before. It should voice and play; replay it (no new cost).
8. **Offline.** Turn on airplane mode, close and reopen the app. Today, Review, drills and the clip from step 7 must work. Speak shows the scenes (or "Try again" if they were never loaded); starting a call shows a connection message. Turn airplane mode off: the scenes load without a reload.
9. **Update pickup.** After deploying a new version, open the app once (it says a new version is ready), close it fully and open it again. The new version must be live (check the change you made).

Write down anything odd, with the time, so the call can be found in the ElevenLabs conversation history.
