# Open Othrys from your phone

Othrys listens only on `127.0.0.1` and refuses a request whose `Host` or `Origin` is not this computer, so a website open in your browser cannot reach it through a DNS name it controls. `127.0.0.1`, `localhost` and any `*.localhost` name, such as a portless URL, are always allowed. To open Othrys from your phone or another computer, put it behind [Tailscale Serve](https://tailscale.com/kb/1312/serve) and add the computer's Tailscale name to the allowed host names.

Anyone who can reach that name gets in without a password: the page carries the local token, as it does on this computer. Tailscale Serve answers only devices on your tailnet. Limit who can reach the computer with your tailnet's access controls, and never use `tailscale funnel`, which publishes the port to the internet.

## Set it up

1. In the [Tailscale admin console](https://login.tailscale.com/admin/dns), turn on MagicDNS and HTTPS Certificates. Tailscale's certificate puts your computer's name, `<computer>.<tailnet>.ts.net`, in the public Certificate Transparency logs, so give the computer a name you are happy to publish before you turn this on.
2. On the computer running Othrys, run `tailscale serve --bg 4747`, with the port Othrys listens on. It serves `https://<computer>.<tailnet>.ts.net/` to your tailnet and passes each request to `http://127.0.0.1:4747`, keeping the name as its `Host`. `tailscale serve status` shows it.
3. Add the name in Settings › Access › Allowed host names, or with `othrys settings set --json '{"allowedHosts":["<computer>.<tailnet>.ts.net"]}'`. The name is allowed as `Host` and as the `Origin` `https://<computer>.<tailnet>.ts.net`; an empty list allows only this computer.
4. On the phone, connect the Tailscale app and open `https://<computer>.<tailnet>.ts.net/`. The phone resolves the name through MagicDNS, which the Tailscale app uses by default.

## Install it as an app

Othrys ships a web app manifest, so Chrome and Edge offer to install it from an HTTPS address. On Android, open the address in Chrome and choose Install app (or Add to Home screen, then Install) from the menu. On a desktop, choose the install icon at the end of the address bar. The app opens your default Titan in its own window.

## Turn it off

Run `tailscale serve --https=443 off` on the computer and remove the name from Allowed host names.
