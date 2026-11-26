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

## Audio quality (about 5 minutes)

Calls now connect over WebRTC and fall back to WebSocket. Listening clips use new voice settings and four new voices, so they are voiced again on their next play (about 7,000 credits for the built-in clips).

1. **Which connection a call used.** Start a call with the browser console open. A line `[coach] WebRTC call failed, retrying over WebSocket` means WebRTC was blocked on this network and the call used the old path. No such line means WebRTC worked.
2. **Glitches in a call.** Talk for two minutes, ideally once on Wi-Fi and once on mobile data. Listen for clicks, short dropouts, robotic "warbling" and the coach's voice speeding up after a gap. On WebRTC, a bad network should sound like brief softening of the voice, not hard cuts.
3. **Echo.** Use the phone speaker instead of headphones. The coach should no longer react to its own voice (WebRTC uses the browser's echo cancellation).
4. **Clips.** Play a clip with Paolo, Roberta, Gianni or Bernardo (they have new voices) and compare it with one of the old voices (Tatiana, Lodovico). Listen for a "phone" sound: thin, boxy, no air on the s and f sounds, a hum or room noise between words. Tell Claude which voices still sound like that, so they can be swapped.
