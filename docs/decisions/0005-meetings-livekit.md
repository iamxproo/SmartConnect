# 0005. Meetings on LiveKit: cloud vs self-hosted

- Status: **Proposed**. LiveKit itself is mandated by the blueprint; the deployment model needs a decision.
- Date: 2026-11-02

## Context

Module E needs 1:1 audio/video calls, group meetings, screen sharing, moderation, reconnection and recording, with 10–30 concurrent rooms initially. The blueprint mandates LiveKit / WebRTC and forbids a custom media transport. LiveKit server **v1.13.11** is **Apache-2.0** (verified 2026-11-02). The server SDK (`livekit-server-sdk` 2.19.2) and client SDKs are Apache-2.0.

## Integration design (independent of hosting)

- **meetings service** owns all authorization:
  - It mints short-lived LiveKit access tokens (room join grant, `canPublish`, `canPublishSources` such as screen share, `canSubscribe`, `roomAdmin` for hosts) only after checking meeting access: join policy, invitation, membership, guest grant.
  - The LiveKit API secret lives only in the meetings service.
- **LiveKit webhooks** (signed) update `meeting_participants` and `meeting_events`: joins, leaves, room finished, egress events.
- **Ephemeral in-call state** (raise hand, reactions, active speaker, mute) uses LiveKit participant metadata and data channels, not the database.
- **Recording** uses LiveKit Egress into the object store ([ADR 0006](0006-object-storage-and-file-security.md)). It requires explicit host action and participant notice/consent events (G-23).
- **Calls** (1:1, ringing, missed) are meetings of kind `call` (G-21). Ringing and accept/reject are signalled through the realtime gateway and push notifications.

## Options

| Criterion | LiveKit Cloud | Self-hosted LiveKit |
|---|---|---|
| Time to first working call | Hours | Days: SFU, TURN/TLS on 443, UDP port ranges, Redis for multi-node, Egress workers |
| NAT traversal / TURN | Global, managed | We run TURN (and TLS on 443 for restrictive networks) |
| Scaling and reliability | Managed multi-region | We size nodes, autoscale and monitor; media nodes need high bandwidth and CPU |
| Recording (Egress) | Managed | Separate Egress service (Chrome-based, CPU-heavy) |
| Cost | Usage-based (participant minutes, egress), predictable at low volume | Infrastructure + bandwidth + engineering time; cheaper only at sustained high volume |
| Data residency / control | Media transits LiveKit's network (region pinning available on paid plans) | Full control |
| Local development and CI | Needs internet + project keys | `livekit-server --dev` runs locally; fully offline tests |

## Recommendation

1. **Local development and CI:** self-hosted LiveKit in **dev mode** as a Compose service (pinned image, loopback-only). Integration tests (token grants, webhooks, permissions) then run offline.
2. **Phase 4 development and pilot:** **LiveKit Cloud**, the fastest route to reliable calls, TURN and recording, with no media infrastructure for the team to operate.
3. **Before production:** benchmark the 10–30 room target and expected minutes (blueprint §10), then compare Cloud cost against a self-hosted cluster *including* operations time. The hosting decision is recorded as a superseding ADR. The integration design above is identical for both, so switching is configuration only.

**Needs from the owner:** budget approval for LiveKit Cloud usage in Phase 4, and any data-residency requirements.
