# Zalo call engine — reverse-engineering notes

Goal: a native Linux replacement for `plugins/capture/ZaloCall.exe` (Zalo PC 26.10.10),
so voice/video calls work without Wine.

## Components (Windows build)

| Piece | Role |
|---|---|
| renderer `call-helper` (module `OU7N`, `re/js/call-helper.js`) | call UI logic; relays signaling between engine and Zalo servers |
| renderer API (module `dThN` → `fBUP`, `re/js/call-api.js`) | HTTP signaling: `getVoiceCallDomain()/api/voicecall/*`, params AES-encrypted with the session key |
| main `3Zc2` (`re/js/main-call-ipc.js`) | spawns the engine, bridges renderer ⇄ engine over two sockets |
| `ZaloCall.exe` (Qt5, 19 MB, i386) | the engine: devices, codecs, media transport (`zrtc`) |
| `ZaviMeet.exe` + **`pdbs/ZaviMeet.pdb`** | Zavi Meet; same engine codebase (818/940 RTTI classes shared with ZaloCall) — the PDB names its functions/types |

## Engine ⇄ Electron IPC (main `3Zc2`)

- Electron is the server, engine is spawned as `engine <recvPath> <sendPath>`.
  - win32: `\\.\pipe\PipeZCallRecv`, `\\.\pipe\PipeZCallSend`
  - else: `/tmp/socketzalorecv2021`, `/tmp/socketzalosend2021` (Unix sockets — Linux takes this branch)
- Frames: `AES(JSON) + "$"`; key `zsecureSecrets().getCallV2TransportAesKey()`; helpers in main module `vqv6` (`encrypt`/`decrypt`/`verifyMd5`).
  Non-win32 send path chunks frames via `buildListMsgs` and waits for an ack read before the next chunk.
- Crypto (`re/js/main-vqv6.js`): AES-128-CBC, IV = 16 zero bytes, key = base64 `getCallV2TransportAesKey()`
  (from `@zsecure/zpc`), ciphertext hex-encoded.
- Chunking Electron → engine on Unix sockets (`4KIH.buildListMsgs`): ciphertext split into 4000-char pieces,
  each suffixed `#<msgId>#<count>#<index>#$` (single piece: just `$`); next piece sent after the engine writes anything back.
  Engine → Electron: plain `hex$hex$…`, no chunking.
- MD5 check of the engine binary (`CALL_NATIVE_HASH`) is enforced only on win32 non-dev.
- Engine → Electron `{type, command, data}`:
  - `update`: `native-ready` (Electron then sends the init data), `callState`, `bubble`, `listDevice`, `advancedOptions`, … → renderer `call-update`
  - `sendSignal`: numeric command → renderer performs the HTTP call, result returned as `recvSignal`
  - `request`: `killMe`, `uploadLog`, `getAliasName`, `popup`, `serverTime`, `actionLog`, `action`, `addFriend`, …
  - `response`: → renderer `call-response-<command>` (e.g. `listDevice`)
- Electron → engine: `{type:"update", command:"init"|"updateLocal", data:initData}`, `{type:"recvSignal", command, data}`,
  `{type:"control", data:<server push event: act=request|answer|group_request|…>}`, makeCall, getDeviceList, language, …

Init data: `local{id,avatar,name}`, `osInfo`, `mainWindowId`, `logPath`(call.log), `zrtcLogPath`, `dumpPath`,
`clientVersion`, `language`, `timeoutMakeCall2ZRtp`, preview flags, default devices, advanced settings.

Renderer → engine requests (call-helper):
- `makeCall` `{partner:[{id,avatar,name}], type, groupInfo, isFirstCall?}` — type 1 voice 1:1, 3 video 1:1, 5 voice group, 6 video group
- `listDevice` (answer: `response`/`listDevice`), `update listDevice` (default devices), `updateLang`, `advancedOptions`
- responses to engine requests: `getAliasName` → `{noisedId, aliasName}`, `serverTime` → `{timestamp}`, `addUser` → `{groupId, calleeIds}`

**The engine owns the call UI** (Qt windows: incoming-call popup, 1:1 audio/video windows, group window, screen share border).

### Captured (engine v0, 2026-10-29)

Zalo launches the engine at startup (`call.launch_native_in_startup = 1`). After `native-ready` it sends `init`
(twice) then `updateLocal`:
`{local:{id,avatar,name}, osInfo, mainWindowId, logPath, zrtcLogPath, dumpPath, clientVersion:"692", language:"vi",
timeoutMakeCall2ZRtp:0, enablePreviewDeviceOutgoing:1, enablePreviewDeviceIncall:1, enableUnstableConnecting:0,
autoAudioInput:true, autoAudioOutput:true, defaultAudInputDevice:null, defaultAudOutputDevice:null, defaultVidDevice:null,
receiveCallWhileNoMicrophoneDetected:true, receiveCallWhileNoSpeakerDetected:true}`

Outgoing click → `{type:"request", command:"makeCall", data:{partner:[{id(noised), avatar, name}], type:1}}` (no signal sent by v0).

Incoming call → `{type:"control", data:{act_type:"voip", act:"request", data:{…}, inCallStatus}}`, then
`act:"cancel"` (status 4) or `act:"answer"` (status 3, answered on another device: `params.codec` = chosen codec).
`act:"request"` data (values redacted):
- `uidFrom` (caller numeric id), `uidN` (caller noised id), `uidTo` (my numeric id), `callId`, `status:"0"`, `ts`
- `codec`: JSON string `[{frmPtime:20, payload:112, name:"opus/16000/1", dynamicFptime:0}]`
- `session` (≈150-char url-safe base64 token, = `params.sessId`), `rtpAddress`/`rtcpAddress` = relay `ip:4200`
- `params` (JSON string): `rtpIP`, `rtcpIP`, `rtpSerIp`, `protocol:3`, `platform:1`, `userId`, `Dname`, `avatar`, `id`(=callId),
  `video:{enable}`, `fec:{enable:3}`, `settings:{voipFTime*, checkPkg*, p2p:1, ping:[1,5000,"8.8.8.8",33433,3000,3], …}`,
  `codec` (caller offers `opus/48000/2` pt113 and `opus/16000/1` pt112),
  `extendData` (JSON string, caller's): `callType, gccAudio, gccMode, gccSVLR, maxFT, negoVidQual, newZrtc:1,
   p2p:[{ip,port,type}] (host/srflx candidates, v4+v6), packetMode:2, platform, sP2P:1,
   serverAddr:[{rtp,rtcp,rtpIPv6,rtcpIPv6,tpType,bonus}], serverResult:[{…,recv,rtt,spTcp}] (relay probes),
   spTcp, srtcp:0, srtpMode:1, supportCallBusy, supportHevcDecode, tpType, video:{codec:[{name:"h264",payload:97}]}}`,
  `zrtc_config` (full engine config, see below — **no `srtpKey`**, `srtpMode:1`, `supportTCP:0`, `numSelectedServer:6`,
   `selectServer2Side:1`, `audioSampleRate:16000`, `audioBitrate:20`, `maxPacketSize:1300`, `bwProfiles[…]`).

## Real traffic (re/call1.pcap — outgoing 1:1 voice call via the Wine engine; IPs/ids redacted here)

All the engine's traffic uses ONE local UDP socket (relay probes, relay session, P2P).

1. **Relay probe / echo** (subcmd 5, kind 0x01), 26 B, 20 per relay to every server in the list, echoed verbatim:
   `01 01 | u32 seq | u32 0 | u32 X | u32 Y | 05 00 | 00 | S2 "<ms-ish counter>"` → RTT/recv counts = `serverResult`.
   Later keepalive to the chosen relay every 100 ms, 40 B: same header, S2 4-char string + 13 zero bytes, also echoed.
2. **InitCall** (subcmd 0x0b caller / 0x0c callee), 185 B, sent to the top relays:
   `01 7e | u32 0 | u32 0 | u32 myUid | u32 0 | 0b 00 | 02 | u32 callId | u32 partnerUid | S2 session(154 B)`
   **Response** kind `0x02`, 53 B: `02 7e | … same header … | u32 0 | u32 callId | u32 relayToken(per relay) | S2 "pubIP|port"`.
3. **P2P** (kind 0x7f) between the two clients' candidates: `7f 00 <dir 0=caller,1=callee> | u32 callId | u16 subcmd | …`
   - subcmd 1 binding request (16 B), 2 binding response with S4 `"ip|port"` (seen address), 4 echo (`01` req / `02` resp, seq, ms string)
   - **subcmd 6 audio**: `7f 00 dir | callId | 06 00 | RTP`; subcmd 7 RTCP (`8f cd …` transport-cc, plaintext, srtcp:0)
4. **RTP**: V2, X=1, PT 112 (opus/16000/1), **SSRC = sender's numeric uid**, one-byte header ext (`be de 00 01`, id 5, 2 B).
   **Payload is encrypted** (Opus TOC byte varies randomly) → 1:1 calls DO use SRTP (RTCP not).
   Media went P2P (same LAN); relay path stays as fallback (kind 0x03 + relayToken + RTP expected there).

## ✅ SRTP key for 1:1 calls — SOLVED (2026-10-29, `tools/srtp-probe.js`)

**master key‖salt = the first 30 ASCII bytes of the signaled `session` token** (16 B key + 14 B salt),
suite **AES_CM_128_HMAC_SHA1_80**, standard RFC 3711 KDF (kdr 0), same key both directions, ROC 0.
Verified on re/call1.pcap: 80/80 audio packets (both directions) pass the HMAC tag; decrypted Opus TOC = 0x48 on every
packet (SILK WB 20 ms mono = opus/16000/1). RTP header incl. extension stays clear; RTCP unencrypted (srtcp 0).

## SRTP key — earlier static analysis (superseded by the result above)

- extendData `srtpMode` is negotiated: effective = (partner == mine) ? mine : 0 (`_parseExtendData`, field +0x3a0).
- ZaviMeet: `createAndInitSRTP(config.srtpKey, …)` returns early when the key is **empty** (no SRTP); otherwise suite 1
  (AES_CM_128_HMAC_SHA1_80) with the same key both directions, separate transports for video (`srtpNoSeq`) / audio (`audSrtpNoSeq`).
  `ZaviZRtcConfig::init` default: srtpKey = "" , srtpNoSeq = audSrtpNoSeq = 1.
- ZaloCall `Peer::createAndInitSRTP` (vtable `zrtc::Peer` slot +0x6c, `FUN_0087140f`): key empty or suite < 1 → slot +0x70
  (disable) and return. Caller not found yet (virtual call; decompiling 0x850000–0x900000 to locate it).
- Captured 1:1 zrtc_config has no srtpKey → either 1:1 media is plain RTP, or ZaloCall derives a key (from session?).
- ZaloCall config parser (`zrtcconfig.cpp`, in range dump line ~58324): srtpKey at int index 0x107, srtpNoSeq 0x10d,
  srtpMode 0x10e, srtpRTCP 0x10f, recordPacket 0x11f.
- Second, direct-call `createAndInitSRTP` = `FUN_008879ca`, called only from `FUN_00883ba4` (**groupcallpeer.cpp**,
  the group-call `_startPeer`): `createAndInitSRTP(peer+0x2ec /*key*/, 1 /*suite*/, …)` → group calls use a
  server-provided key. The 1:1 `Peer` virtual (slot +0x6c) has no call site found in 0x850000–0x900000.
- `FUN_008e0fd5` builds our own extendData (newZrtc, platform, packetMode, gccMode, srtpMode, …).
- Plan: settle 1:1 SRTP empirically — RTP headers stay clear under SRTP; try decoding the Opus payload of the
  first relayed packets (plain → decodes; SRTP → noise + 10-byte auth tag).

Range dumps: `re/out/zalocall-range/range-00850000-00900000.c` (4674 functions), `re/out/zalocall-src/` (330 fns tagged
by source file), helpers `tools/pe-xref.py` (raw pointer/thunk xrefs), `tools/pe-vtable.py` (vtable → class + slot).

## Linux engine plan

Implement the engine in JS inside Electron instead of a native binary:
- main process: replace the `spawn(ZaloCall)` in `3Zc2` with an in-process engine (or keep the socket protocol and
  run it as a utility process) — the IPC contract above is the boundary.
- call window = an Electron BrowserWindow: UI in HTML, `getUserMedia` (Chromium AEC/NS/AGC), WebCodecs
  (Opus, H.264), Web Audio playout.
- transport in Node: `dgram` UDP (+ `net` TCP fallback), SRTP (AES-CM + HMAC-SHA1) via node `crypto`.

## Signaling commands (engine `sendSignal` → HTTP)

| cmd | API | path |
|---|---|---|
| 401 | requestCall(calleeId, callId, codec, type) | /api/voicecall/requestcall |
| 416 | sendRequestCall(calleeId, rtcpAddress, rtpAddress, codec, extendData, session, callId) | /api/voicecall/request |
| 407 | ringring | /api/voicecall/ringring |
| 402 | answer(callerId, callId, status, codec, extendData, rtcpAddress, rtpAddress, session) | /api/voicecall/answer |
| 408 | answerack | /api/voicecall/answerack |
| 405 | cancel | /api/voicecall/cancel |
| 409 | endcall | /api/voicecall/endcall |
| 406 | logendcall | /api/voicecall/logendcall |
| 411–414 | hold/unhold req/resp | /api/voicecall/{hold,unhold}{req,resp} |
| 12006 | on/off cam+mic | /api/voicecall/conf |
| 12064 | on/off sharescreen | /api/voicecall/requestsharescreen |
| 12433–12447, 12097, 12098, 12043, 12044 | group calls | /api/voicecall/group/* |

## Media (from a real call's QoS log, ~/.config/ZaloData/call.log)

- audio codec `opus/16000/1`, 20 ms frames
- relay `58.187.8.51:4200` (both rtp and rtcp address in that sample)

## Engine internals (ZaviMeet.pdb, namespace `zrtc`)

Transport: `UdpIOThread`/`UdpNetworkIOHandler`, `TcpIOThread`/`TcpNetworkIOHandler` (fallback), `NetworkRetryThread`,
`NetworkControlProtocol`. Packets: `ZRTPPacket`/`VZRTPPacket`. Crypto: `SrtpTransport`, CryptoPP.
Media: `AudioRtpRtcp`, `VideoRtpRtcp`, `WebRtcVideoCoding`, `VideoAudioSync`, `BandwidthProfile*`.
ZaloCall also links OpenH264 (`Wels*`) and x265/HEVC.

No ICE/DTLS/SDP strings in ZaloCall → standard WebRTC transport is NOT used; only its media modules.

## Source layout (paths leaked in ZaloCall.exe strings)

`voip_platform/callpc/zalocallplugin/zalo_call_process/source/`
- `communication/` zcrytomessage (IPC AES), zmessagedeseralizer(+callgroup), zmessagetransfer(+callgroup)
- `zcall/` main, zcallprocess(+group), `1_1/` peerwrapper, zcallinfo, zcallinfosignal, zcallinfocallbackimpl; `group/` …
- `ui/` Qt windows; `zipc/zipcwindows.cpp`

`voip_platform/core/zrtc_core/zrtc/`
- `conference/` **peercallzrtpimpl** (relay "ZRTP" handshake), **zrtpserverinfo**, **callp2pcontroller**,
  peernetworkimpl, peerpreconnectimpl, peercodecimpl, callcontroller, groupcall/*, config/{zrtcconfig,devconfig,lowdatamodeconfig}
- `network/` udpiothread, udpnetworkiothread, tcpiothread, audiortprtcp, videortprtcp, videoaudiosync,
  **zrtcpacketrecorder** / zrtcpacketplayer
- `srtp/srtptransport`, `zcommon/controlnetwork`, `event_loop/*`, `device/*`, `codec/*`

"ZRTP" = Zalo's name for its **relay servers** (`ZRTPServer`, InitZRTP/ChangeZRTP, selectServer, token),
not RFC 6189. There is also a P2P path (custom binding request/response with seq/candId, TYPE_ECHO).
SRTP parameters look signaled, not negotiated in-band: `srtpKey`, `srtpMode`, `srtpNoSeq`, `srtpRTCP`, `audSrtpNoSeq`.
Log line: `_initCallConfig caller, userId, partnerId, callId, sessionId, protocol, videoCall, statFilename, extraInfo`.

Lead: "disable srtp when in record packet mode" — a debug packet recorder exists; enabling it in a real
(Wine) call would yield plaintext packet captures to validate the reimplementation.

## Wire format — `zrtc::ZRTPPacket` (ZaviMeet decompile, `re/out/zavimeet/zrtc_ZRTPPacket.c`)

All multi-byte integers are written raw on x86 → **little-endian**.
Packet object fields (offsets into the C++ object): `+4` kind u8, `+5` u8, `+8/+0xc/+0x10/+0x14` u32,
`+0x18` subcommand u16, `+0x1a` flags u8, `+0x1c` std::string (S2 = u16-length-prefixed),
`+0x34/+0x38/+0x70` u32, `+0x44` std::string (S4 = u32-length-prefixed), `+0x77` payload, `+0x5f0` payload len.

Byte 0 = kind:
- `0x01` control/request (relay). Layout: `01 | u8(+5) | u32(+8) | u32(+0xc) | u32(+0x10) | u32(+0x14) | u16 subcmd | u8 flags | …`
  Allowed subcmds: 2, 3, 5, 0x0b, 0x0c, 0x0e, 0x20, 0x21, 0x33.
  - 0x0b / 0x0c = **RequestInitCall** as caller / callee: then `u32(+0x34) u32(+0x38)` (or for flags==6 / subcmd 0x33:
    `u32(+0x70) u8 u8 u8`), then S2 string `+0x1c`, then (0x0c/0x33, if present) S4 string `+0x44`.
  - 3: `u32(+0x34)`…; 2/0x0e, 5, 0x20 (sub-flags 7..0x10): more strings — still to map.
- `0x03` audio, `0x05` audio (alt flag), `0x07` audio FEC, `0x0d` / `0x0f` video(?):
  `kind | u32 id(+0x14) | payload` — payload is the (S)RTP packet. **Media over relay = 5-byte header + SRTP.**
- `0x7f` P2P: `7f | u8(+5) | u8 | u32(+0x34) | u16 subcmd | [u8 flags | u32(+0xc) | …]`
  subcmd 6/7 audio, 10 audio FEC (no extra header), 1 = binding?, 2/3 with S4 string, 4 with string/raw.

`initZRTPPacketRequestInitCall(bool isCaller, u32 a→+0x10, u32 b→+0x38, u32 c→+0x34, string s→+0x1c, bool, string, bool)`:
subcmd = isCaller ? 0x0b : 0x0c; flags = bool+1 (|4 if last bool). Semantics of a/b/c/s come from ZaloCall's peercallzrtpimpl.

## SRTP (`zrtc::SrtpTransport`, modeled on webrtc/libsrtp)

`SetUpKey(int suite, string keyA, string keyB)`: send/recv keys swapped by role (caller vs callee), then
`SetRtpParams(suite, sendKey, …, suite, recvKey, …)`. Keys arrive as strings (signaled — `srtpKey`), no DTLS.
Suite ids likely webrtc's (1 = AES_CM_128_HMAC_SHA1_80, 2 = _32); forced to 3 when `this+0x24` set — to check.

## ZaloCall.exe findings (Ghidra, no symbols — `re/out/zalocall/by-strings.c`, functions tagged by strings)

- `FUN_008d8799` = `_parseExtendData`: the per-call **extendData JSON** exchanged via signaling (416 request / 402 answer).
  Keys: `p2p callType video codec newZrtc packetMode gccMode gccAudio gccEarlyCall gccSVLR srtpMode srtcp maxFT platform
  fecTP supportHevcDecode tpType spTcp serverAddr extraInfo serverResult select2side numServers`.
- `FUN_00894a72` (13.5 KB) parses the **zrtc config JSON** (~300 knobs: codecs, bitrates, AEC/AGC/NS, GCC, servers,
  TCP fallback, SRTP). SRTP knobs live here: `srtpKey`, `srtpMode`, `srtpRTCP`, `srtpNoSeq`.
  Also `recordPacket` → "disable srtp when in record packet mode" (packet recorder), `fallbackServers`, `tcpServers`,
  `supportTCP`, `forceTCP`, `selectServer2Side`, `numSelectedServer`, `timeWaitSelectServer`, `maxRetryInitZRTP`.
  Source of this config (server push? requestcall response?) — to capture.

## Open questions

1. Response shape of 401 requestcall (where rtp/rtcp relay addresses and `session` come from).
2. ZRTPPacket wire format; handshake with the relay; how SRTP keys are derived (session? ZRTP?).
3. RTP payload/packetization for Opus and H.264/H.265.
4. Exact IPC JSON for every command (capture from a real run).

## Relay control packets (verified against re/call1.pcap) and the first real incoming-call test

Request header (21 B): `01 | ver | u32 0 | u32 id | u32 uid | u32 token | u16 subcmd | u8 flags`.
- echo subcmd 5: id = counter, uid/token = fixed `0x003e9765 / 0x012f833c`, S2 text (ms counter), optional zero
  padding (40 B pre-call probes every 100 ms per relay; in call 3 × 28 B every 2 s). Echoed verbatim.
- ping subcmd 2 (flags 1): uid, token, S2 session — every 6 s in call.
- EndCall subcmd 3 (ver 0x7e): uid, token, u32 callId — the caller sends it to the relays it registered on but
  does not use, as soon as the answer arrives. The relay forwards it to the peer as a response:
  `02 01 | 0 | 0 | partnerUid | 0 | 03 00 | 00 | i32 0`.
- subcmd 0x20 flags 0x0a: partner's in-band signals relayed every 1 s (S4 payload), ignorable.

First real test (phone → native, 2026-10-29): our 402 was accepted (answer_ack), the relay answered our callee
InitCall, but ~110 ms after the answer the phone's EndCall arrived for that relay and no media ever came. The
caller's request listed one relay in serverAddr but four in serverResult; our answer had `serverResult: []`.
The engine now joins and probes every candidate, answers with our serverResult, and locks onto the relay that
carries the partner's audio.

## Signal ids are noised ids (strings)

ZaloCall.exe parses `uidFrom`/`uidTo` as uints but `uidN` as a string, and its 1:1 signal builders
(`FUN_0072f250` 402 answer, `FUN_0072f860` 407 ringring, `FUN_0072f9c0` 409 end — `re/out/zalocall/callers-0072f250.c`)
put a **string** in `callerId` / `toId`: the noised id. With the numeric uid the server still answers "Successful"
and the caller even gets the answer, but the callee's other devices keep ringing and the caller never gets our
end_call (it waits ~16 s and drops with "unstable connection").

## Relay choice belongs to the callee's answer

Third real test: the phone sent early media on relay .76 right after we joined; our engine locked onto it and
sent EndCall to the other three — including .135, the caller's preferred relay, which our answer then named.
The phone followed the answer (left .76 at once), found our EndCall on .135 and showed "callee declined".
So: never leave a relay before answering; name one relay in the answer (prefer the one carrying early media),
lock onto it, then leave the rest.

## 402 status: 0 = accept, 3 = decline

`UiAnswerCallEvent(accept)` (`FUN_007e44c0`, zcallinfocallbackimpl.cpp): accept → start the media path only;
decline → 402 with status **3** + end (reason 9). `UiCloseEvent` while ringing also sends status 3.
The real answer is sent by `FUN_007d8ef0` once connected, with status **0**, and sets the answered flag (+0x5b3).
Our earlier status 3 only "worked" while callerId was numeric (the server then ignored most of the answer);
with the proper noised callerId the caller showed "declined".

## Phase 1 working (2026-10-29)

Incoming 1:1 voice works end to end on the native engine: two-way audio, other devices stop ringing, hangup and
decline reach the caller. Media facts from the live call: before the answer the caller sends early media as
plain RTP pt 113 (opus/48000/2); after a status-0 answer it restarts the stream (new seq) as SRTP pt 112, so
the player resyncs on payload-type change / runs of "late" packets. Chromium 108's AudioEncoder ignores
`opus.frameDuration` and emits 60 ms code-3 packets; packets.splitOpus repacketizes them into 20 ms frames.

## Outgoing: 401 requestcall (verified against the server 2026-10-29)

Request `{calleeId: noised id, callId, codec, typeRequest: 0}` — **the caller picks callId** (0 → error 114
"Tham số không hợp lệ", and Zalo then sends no recvSignal at all). Response (= recvSignal 401 data):
`{id (our callId), fromId, toId (numeric uids), sessId (154 chars), rtpIP, rtcpIP, protocol 3, status 0, msg,
servers: [{rtpaddr, rtcpaddr, rtpIPv6, rtcpIPv6, bonus, spTcp}] (6 relays), zrtc_config {...}, settings {...},
fec, video, changeZRTP, showDebugInfo, ts}`.

## Outgoing call verified (2026-10-29) + caller-side pushes

Real outgoing call worked (ring, answer, two-way SRTP pt 112 via the relay named in the answer's `rtpSerIp`).
Caller-side pushes: `ring_ring` (params.extraData = callee's codec/extendData), `answer` (status "0" accept,
params {rtpSerIp, codec, protocol, extendData, …}), `mute_audio` (params.type 1/0), `end_call`.
Answer status **1** = busy: a phone that is itself dialing us answers our 416 with status 1 within ~150 ms
(both sides called each other at once; our engine ignored the phone's incoming request and the phone logged it
as a missed call). The engine now replies 402 status 1 to calls arriving while it is busy.
406 logendcall `{callId, partnerId, status, role, data, duration}` is still not sent (status/data values unknown).

## 406 logendcall drives the chat's call message

`sync_call_message.ui = 1` by default, so the engine's `bubble` update is ignored and the server writes the call
message from each side's 406. Without it: incoming answered calls showed "Bạn bị nhỡ", outgoing showed nothing.
ZaloCall.exe (`FUN_007d7840`, call site 0x7d8b4e): args callId, partnerId (noised id string), status
[+0x5e0], role [+0x5c4] (= isCaller), data [+0x5c8] (stats JSON incl. sysInfo/devcInfo/duration), duration [+0x5e4].
status: connected → engine result `argmax(six counters)*10 + flag` (0..51); caller not connected → 0x65/0x66/0x6e/0x6c
by end kind, else by callee answer status (1 busy → 0x69, 3 decline → 0x6a, 5 → 0x6b), else 0x67/0x68;
callee not connected → 0xa3 / 0x9e / 0x9f / 0x9a / 0xa1–0xa2, decline (reason 9) → 0xa0.

## Video (first real calls, 2026-10-29)

- Video RTP rides relay kinds 0x0d (out, + token) / 0x0e (in) / 0x0f (RTCP); same SRTP master key as audio
  (separate context), SSRC = the sender's uid (same as audio), **no header extension**.
- Phones send pt 97 and 98 (both H.264), plus a few pt 100 (unknown). extendData `video.codec [{h264, 97}]`,
  `negoVidQual: 1`, zrtc_config maxWidth 640 / maxHeight 480 / maxBitrate 800, h264Decoder 1, videoNack.
- Packetization = Zalo's webrtc `RtpPacketizerH264` **mode 3** (ZaviMeet 0x00a84a50 GeneratePackets /
  0x00a853b0 Parse): the whole Annex B access unit (start codes included) is cut into FU-A-shaped packets
  `1c | S/E | bytes`. Standard single-NAL/FU-A packets are not understood by the phone.
- Pushes during video calls: `onoff_camera` (params {reason, type 0/1/2}), `mute_audio`. Our state goes out
  as 12006 `/api/voicecall/conf {calleeId, callId, isOnCam, isOnMic, data}` (ZaloCall builder near by-strings 4566).
- On the incoming video call the phone sent no video at all (open question: negoVidQual handshake?).
- Second round: pt 98 = keyframe packets (FU-shaped `1c 80/00/40` fragments, SPS/PPS/SEI/IDR), pt 97 = delta
  frames that fit one packet, sent as **raw Annex B** (payload starts 00 00 00 01, no header). One keyframe per
  ~10 s, 240×426 @ ~30 fps (phone limited itself: no RTCP from us). The phone sends video RTCP SR (81 c8, RC 1).
  Engine now answers with SR + report block + REMB (800 kbit/s) every second on 0x0f.
- Third round: phone→PC video works (240×426 → 480×852 once we send SR/RR/REMB). PC→phone failed: the phone
  kept requesting keyframes (≈2 keyframes/s from us instead of 1 per 2 s). Mode-3 parsing cannot tell frame
  types from the payload, and the phone marks keyframes with pt 98 → our keyframes now go out as pt 98.

## Screen sharing in 1-1 calls (ZaloCall.exe 26.10.10)

- No separate peer in 1-1 calls (`ShareScreenPeer` exists only under `zrtc::groupcall`):
  the screen replaces the camera on the normal video stream ("Your camera will be
  turned off during screen sharing"; "Share screen is only available in video call").
- UI → `PeerWrapper::shareScreen(on, id, …)` (peerwrapper.cpp, FUN_007cd810) then
  `sendOnOffSharescreen` (zmessagetransfer.cpp FUN_00734b20 → FUN_0072ffe0):
  `sendSignal 12064 {uidTo: noised id string, callId, status}` → Zalo JS
  `/api/voicecall/requestsharescreen`. status is the on/off bool: 1 on, 0 off.
- Partner side: server push `act: 'share_screen'`, parsed by FUN_00720310 as
  `{callId, params: '{"status":…}'}` → `ui:partnerSharescreenStateChange, %d`.
- Native port: PipeWire capturer (`--enable-features=WebRTCPipeWireCapturer`;
  xdg-desktop-portal shows its picker), ≤1280×720 @10 fps, 1 Mbps (Zalo's top
  bwProfile is 720p/1100 kbps). A new VideoEncoder per source size: reconfiguring
  OpenH264 keeps the old SPS and then sends SPS id 0 and 1 in every keyframe.
