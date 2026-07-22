# QueryLoad Organization Deployment (Server Mode)

**Pattern B (D25).** One office machine runs the QueryLoad engine as a server;
staff connect from their own machines with the dedicated client, never a
browser. Everything stays on the LAN; nothing leaves the building.

## 1. Set up the server

1. Install QueryLoad on the server machine (a strong PC or Windows Server).
2. (Optional, recommended) run the engine as a Windows Service so it starts on
   boot and recovers automatically:
   ```
   npm run engine:service           # install + start (elevated shell)
   ```
   The service is configured to auto-restart with backoff if it exits, so a
   reboot brings the engine back with no manual step.
3. In the app: **Settings → Admin → Organization Mode → Enable**, then restart
   the engine (or the service) so it binds the LAN.
4. Add document folders and assign them to workspaces (matters / patients /
   clients). Create user accounts and assign each user to the workspaces they
   may see. Membership is the ethical wall (D54).
5. Copy the **join code** shown in Organization Mode and share it with staff.

## 2. Connect a client machine

1. Install the QueryLoad client (the same app; the LAN-hosted installer is
   available from the server).
2. On first run, the client **auto-discovers** servers on the LAN (mDNS). Pick
   the server, or paste the **join code**.
3. The join code pins the server's certificate (trust bootstrap) and authorizes
   the device. The user then signs in with their account.
4. The client stores only UI preferences and the connection config, with **no
   document content and no chat cache** live on the client (chat history is
   kept server-side under the user's account, D34/D58).

## 3. Silent install for IT tooling (MSI)

The MSI supports unattended deployment:

```
msiexec /i QueryLoad.msi /qn /norestart
msiexec /i QueryLoad.msi /qn INSTALLDIR="C:\Program Files\QueryLoad"
```

## Security notes

- All client↔server traffic is TLS, including the certificate pinned via the
  join code. Multicast discovery is link-local and never leaves the building.
- Admins can revoke a device session at any time (Settings → Admin), and the
  device loses access immediately.
- Leave the Engine API disabled unless you have a specific, audited need.
- See `threat-model.md` for the honest list of what server mode does and does
  not protect against, and `sizing-table.md` for server sizing by users ×
  documents.
