---
kind: task
title: Companion 05: Hello tells the push connection from the command connection
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: moderate
---
Blocked by: none (can start immediately)

Part of `companion.md`. It resolves the existing card `device-pushes-reach-the-command-connection.md`: read that card and the spec (section "The daemon's remote transport") first.

## What to build

The daemon registers every token-proven app connection for pushes. The desktop opens two connections, and the command connection reads the first message it receives as the reply to its request. So a device push arriving while a request is in flight is taken for the reply, and the connection stays one message out of step from then on.

To fix it:

- Give `Hello` a field saying which connection this is: push or command. Ticket 12 adds forwarding.
- Send device pushes only to the push connection.
- Make the app send the field.
- Bump the protocol, with a `min_version_for` arm.

## Acceptance criteria

- [ ] A test shows a device push during an in-flight command never displaces that command's reply
- [ ] An older app that sends no field keeps today's behaviour
- [ ] The existing card is resolved and set Done
