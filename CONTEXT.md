# Gavin

A desktop workspace where a human runs and steers coding agents in terminals, led by a PRD and a board of cards. This glossary names the concepts the code and the design documents share.

## Language

### Remote access

**Workstation**:
A computer running the Gavin desktop app and its daemon. It is what a Device pairs with, and what the Companion works on.
_Avoid_: host (that is an ssh workspace's machine), instance, server, Mac

**Companion**:
The phone app a human uses to watch and steer their Workstations while away from the desk.
_Avoid_: mobile client, phone app, mobile app

**Device**:
One install of the Companion, identified by its own keys to every Workstation it has paired with. An iPhone and an iPad are two Devices, and a reinstall is a new Device.
_Avoid_: phone, client, paired phone

**Workstations hub**:
The Companion's home screen: every paired Workstation with its state, and one attention inbox across all of them.
_Avoid_: hub (on its own, that is the desktop app's view one level above any workspace), home, dashboard

**Demo Workstation**:
A simulated Workstation built into the Companion, with sample sessions, cards and rails, for exploring the app before any real Workstation is paired.
_Avoid_: demo mode, sample data, offline mode

**Unlock**:
One authentication on a Device (a biometric, or the phone's passcode), together with how long it lasts: until the Companion goes to the background or the phone locks.
_Avoid_: session (that is a terminal), login

**Remote role**:
What a Workstation lets a connection from an unlocked Device do: everything its desktop app can do, except manage Devices.
_Avoid_: mobile permissions, remote access (as the name of the permission)

**Relay**:
The server that carries encrypted traffic between a Workstation and its Devices without being able to read it.
_Avoid_: proxy, tunnel, server

**Push gateway**:
The publisher's service that delivers encrypted notifications to Devices through Apple and Google, and the only holder of the publisher's push credentials.
_Avoid_: notification server, push server
