# SixDoFone

This is a python app for 

## Setup

### Install requirements

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

or just install uv and let it manage everything else just-in-time.

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```


### Get HTTPS working
<details>
<summary>
#### Option A: Setup tailscale on all devices
</summary>

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
</details>

<details>
<summary>
#### Option A: Setup tailscale on all devices
</summary>

This is the quickest way to get things set up, but you may find that ngrok adds quite a lot of latency. If you find yourself only getting a couple of poses per second then consider switching to tailscale.

* Go to https://ngrok.com and sign up
* run `ngrok config add-authtoken <your auth token>` to make ngrok happy
  <!-- FIXME: uninstall ngrok and add some better instructions here -->
  * if you don't have ngrok installed, just plough through and let it fail when running, then try again (pyngrok will install ngrok for you)

</details>

### Add a .env file

```bash
cp .env.example .env
```
and then add a SIXDOFONE_SHARED_SECRET by following the instructions in your new .env file.

Also set USE_NGROK or USE_TAILSCALE to something nonempty, to pick one of them to use.


## Running the app

Inside the python virtual environment, run:

```bash
python app.py
```

or if you are using uv, just run

```bash
./app.py
```

and it will manage the virtualenv and dependencies for you.

This will start the server on http port 8000, which tailscale will expose as https://yourhostname.your-tailnet-domain.ts.net/.

<!-- TODO: add a jupyter-style auth token to the url and print it somehow? -->

## Hacking

Some notes:

* You do not need nodejs in order to run the python server.
  * I did add @ts-check to the top of some files though, and you can run `npm install` to get clean type-checking in vscode.
  * Once https://tc39.es/proposal-type-annotations/ is implemented in some browsers, I will probably switch to using that.
  * I may add some CI checks for the typescript bits in the future. No promises.
* I initially picked flask because I heard a rumour that this is what lerobot are using for some of their tools. I might switch to something pydantic/fastapi-based at some point though.
