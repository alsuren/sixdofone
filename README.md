# SixDoFone

This is a python app for 

## Setup


### Setup tailscale on all devices

This is recommended so that your phone can talk to your computer over https. You could use ngrok instead if you want.

Once you have installed tailscale on all devices, you can set up https-to-http proxying by doing:

```bash
tailscale serve --bg localhost:8000
```

It should print something like:

```
Available within your tailnet:

https://yourhostname.your-tailnet-domain.ts.net/
|-- proxy http://localhost:8000

Serve started and running in the background.
To disable the proxy, run: tailscale serve --https=443 off
```

### Install requirements

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## Running the app

Inside the python virtual environment, run:

```
python app.py
```

This will start the server on http port 8000, which tailscale will expose as https://yourhostname.your-tailnet-domain.ts.net/.

<!-- TODO: add a jupyter-style auth token to the url and print it somehow? -->
