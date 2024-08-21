#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "flask==3.*",
#     "rerun-sdk==0.17.0",
#     "opencv-python==4.*",
#     "pyquaternion==0.9.*",
#     "pyngrok==7.*",
#     "python-dotenv==1.*",
#     "pymycobot==3.*",
#     "requests==2.*",
# ]
# ///
import hashlib
import hmac
import json
import logging
from dataclasses import dataclass, field
import subprocess
from time import sleep
from typing import Literal
import os
import sys


from dotenv import load_dotenv
from flask import Flask, request, jsonify, redirect
import rerun as rr
import numpy as np
import numpy.typing as npt
import cv2
from pyquaternion import Quaternion
from pyngrok import ngrok
from pymycobot import MyCobotSocket
import requests
from PIL import Image
from io import BytesIO

load_dotenv()
SIXDOFONE_SHARED_SECRET = os.environ.get("SIXDOFONE_SHARED_SECRET")

app = Flask(__name__)


@dataclass
class Pose:
    position: npt.NDArray[np.float64]
    orientation: Quaternion
    gamepad_axes: npt.NDArray[np.float64]


def pose_from_webxr(
    position: dict[Literal["x"] | Literal["y"] | Literal["x"], float],
    orientation: dict[Literal["w"] | Literal["x"] | Literal["y"] | Literal["x"], float],
    gamepad_axes: list[float],
):
    """
    Note that the webxr idea of x, y and z are based on the starting position of the camera,
    where y+ is "up" and z+ is "close" (TODO: double-check this).
    We need to convert them to the x, y, z of the table, where z+ is "up" and y+ is "away"
    """
    return Pose(
        position=np.array(
            [
                position["x"],
                -position["z"],
                position["y"],
            ]
        ),
        orientation=Quaternion(axis=[1, 0, 0], degrees=90)
        * Quaternion(
            w=orientation["w"],
            x=orientation["x"],
            y=orientation["y"],
            z=orientation["z"],
        ),
        gamepad_axes=np.array(gamepad_axes)
    )


# position is in metres, and a 1m long arrow looks a bit silly in rerun.
SHORT_FORWARD_VECTOR = np.array([0, 0, -0.1])

CURRENTLY_DRAGGING = False
PREVIOUS_POSE = Pose(
    position=np.array([0, 0, 0]),
    orientation=Quaternion(axis=[1.0, 0.0, 0.0], degrees=90),
    gamepad_axes=np.array([0, 0]),
)
PREVIOUS_DRAG_END_POSE = Pose(
    position=np.array([0, 0, 0]),
    orientation=Quaternion(axis=[1.0, 0.0, 0.0], degrees=90),
    gamepad_axes=np.array([0, 0]),
)
CURRENT_DRAG_POSE = Pose(
    position=np.array([0, 0, 0]),
    orientation=Quaternion(axis=[1.0, 0.0, 0.0], degrees=90),
    gamepad_axes=np.array([0, 0]),
)

def pose_to_coord_offset(pose: Pose) -> npt.NDArray[np.float64]:
    yaw, pitch, roll = pose.orientation.yaw_pitch_roll
    print(f"{yaw=}, {pitch=}, {roll=}")
    return np.array([
            # west
            (100 * -CURRENT_DRAG_POSE.position[1]),
            # south
            (100 * CURRENT_DRAG_POSE.position[0]),
            # up
            (100 * CURRENT_DRAG_POSE.position[2]),
            # clockwise around northeast-southwest axis?
            np.degrees(yaw),
            # clockwise around northwest-southeast axis?
            np.degrees(roll),
            # anticlockwise around vertical axis
            np.degrees(pitch),
    ])

# FIXME: put this in .env or something?
NEUTRAL_COORDS = np.array([
    210, # west
    -40, # south
    180, # up
    -180, # clockwise around northeast-southwest axis?
    0, # clockwise around northwest-southeast axis?
    -45, # -225, # anticlockwise around vertical axis
], dtype="float64") - pose_to_coord_offset(CURRENT_DRAG_POSE)

print(f"{NEUTRAL_COORDS=}")

# Route to serve the HTML file
@app.route("/")
def index():
    return redirect("static/sixdofone.html")


# API endpoint to receive the position and rotation data
@app.route("/api/report", methods=["POST"])
def report():
    if SIXDOFONE_SHARED_SECRET:
        method, token = request.headers.get("Authorization", ' ').split(' ')
        if method.lower() != 'hmac' or not token:
            print("missing hmac")
            return jsonify({"status": "missing hmac"}), 403
        expected_hmac = hmac.new(SIXDOFONE_SHARED_SECRET.encode(), request.data, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected_hmac, token):
            print("invalid hmac")
            return jsonify({"status": "invalid hmac"}), 403
    
    report_inner(request.json)
            
    return jsonify({"status": "success"}), 200


def report_inner(data):
    global CURRENTLY_DRAGGING
    global PREVIOUS_DRAG_END_POSE
    global CURRENT_DRAG_POSE

    # e.g.
    # {
    #     'position': {'x': 0, 'y': 0, 'z': 0},
    #     'orientation': {'x': 0, 'y': 0, 'z': 0, 'w': 1}, # quaternion
    #     'dragStartPosition': {'x': 0, 'y': 0, 'z': 0},
    #     'dragStartOrientation': {'x': 0, 'y': 0, 'z': 0, 'w': 1}, # quaternion
    # }
    # Note that the webxr idea of x, y and z are based on the starting position of the camera,
    # where y+ is "up" and z+ is "close" (TODO: double-check this).
    # We need to convert them to the x, y, z of the table, where z+ is "up" and y+ is "away"
    #
    # FIXME: add some types to this mess.
    data = request.json

    # print(f"got: {data}")

    pose = pose_from_webxr(
        data["position"],
        data["orientation"],
        data.get("gamepadAxes", []),
    )
    if data.get("dragStartPosition") and data.get("dragStartOrientation"):
        CURRENTLY_DRAGGING = True
        drag_start_pose = pose_from_webxr(
            data["dragStartPosition"], data["dragStartOrientation"], data["dragStartGamepadAxes"],
        )

        CURRENT_DRAG_POSE = Pose(
            PREVIOUS_DRAG_END_POSE.position - drag_start_pose.position + pose.position,
            pose.orientation
            * drag_start_pose.orientation.conjugate
            * PREVIOUS_DRAG_END_POSE.orientation,
            PREVIOUS_DRAG_END_POSE.gamepad_axes - drag_start_pose.gamepad_axes + pose.gamepad_axes,
        )
        rr.log(
            "phone/drag",
            rr.Arrows3D(
                origins=[CURRENT_DRAG_POSE.position],
                vectors=[CURRENT_DRAG_POSE.orientation.rotate(SHORT_FORWARD_VECTOR)],
                colors=[
                    (1 + pose.gamepad_axes[0]) / 2,
                    (1 + pose.gamepad_axes[1]) / 2,
                    0,
                ]
            ),
        )
        desired_coords = NEUTRAL_COORDS + pose_to_coord_offset(CURRENT_DRAG_POSE)

        MYCOBOT.send_coords(desired_coords, mode=1, speed=20)
        print(f"desired_coords={[f'{coord:.2f}' for coord in desired_coords]}")
        # Currently unplugged, so I can't really test it.
        MYCOBOT.set_gripper_value(int((1 + pose.gamepad_axes[0]) * 45), 20)
        actual_coords = MYCOBOT.get_coords()
        if actual_coords is not None:
            # The robot most often returns None here, which is quite frustrating.
            # It seems to depend on what commands were recently sent or something?
            print(f"actual_coords={[f'{coord:.2f}' for coord in actual_coords]}")


    elif CURRENTLY_DRAGGING:
        CURRENTLY_DRAGGING = False
        PREVIOUS_DRAG_END_POSE = CURRENT_DRAG_POSE

    # FIXME: find a way to set "visible time range" programmatically to give us a tail of previous
    # arrows (probably by setting a blueprint on startup). For now I've been setting it up manually.
    rr.log(
        "phone/current",
        rr.Arrows3D(
            origins=[pose.position],
            vectors=[pose.orientation.rotate(SHORT_FORWARD_VECTOR)],
        ),
    )
    ret, img = CAP.read()
    if ret:
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        rr.log("webcam", rr.Image(rgb))
    
    mjpeg_url = os.environ.get("MJPEG_URL")
    if mjpeg_url:
        rr.log(
            "robot/webcam",
            rr.ImageEncoded(
                contents=get_mjpeg_frame(mjpeg_url),
                format="JPEG",
            ),
        )

def get_mjpeg_frame(url: str) -> Image:
    response = requests.get(url, stream=True)

    # Iterate over the response content to find the first frame
    byte_data = b""
    for chunk in response.iter_content(chunk_size=1024):
        byte_data += chunk
        # MJPEG frames start with the JPEG SOI (Start of Image) marker: 0xffd8
        if b'\xff\xd8' in byte_data and b'\xff\xd9' in byte_data:
            # Find the start and end of the JPEG frame
            start = byte_data.index(b'\xff\xd8')
            end = byte_data.index(b'\xff\xd9') + 2
            jpeg_data = byte_data[start:end]
            break

    return jpeg_data

if __name__ == "__main__":

    
    logging.getLogger("werkzeug").setLevel(logging.ERROR)

    # You need to sign up to ngrok and run `ngrok config add-authtoken ...` before this will work.
    # This is slightly quicker to set up than tailscale, but has really dreadful latency because
    # it can't keep everything inside your local network.
    if os.environ.get("USE_NGROK"):
        if not SIXDOFONE_SHARED_SECRET:
            import secrets

            print(f"Refusing to set up a public tunnel without authentication. Please add\n\n\
                  SIXDOFONE_SHARED_SECRET={secrets.token_hex(30)
                                   }\n\nto your .env file"
            )
            sys.exit(1)

        if os.environ.get("WERKZEUG_RUN_MAIN") != "true":
            tunnel = ngrok.connect("http://localhost:8000", bind_tls=True)
            print(
                f"ngrok tunnel set up. Go to {tunnel.public_url}/static/sixdofone.html?secret={SIXDOFONE_SHARED_SECRET}"
            )
    
    # This is slightly harder to set up than ngrok, but it's worth is because it doesn't have to
    # route everything via ngrok's servers. This means that the latency is **much** better.
    if os.environ.get("USE_TAILSCALE"):
        if not SIXDOFONE_SHARED_SECRET:
            import secrets

            print(f"Refusing to set up a public tunnel without authentication. Please add\n\n\
                  SIXDOFONE_SHARED_SECRET={secrets.token_hex(30)
                                   }\n\nto your .env file"
            )
            sys.exit(1)
        try:
            out = subprocess.check_output("tailscale serve status --json".split())
            tailscale_tunnels = json.loads(out)
            print(f"got {tailscale_tunnels=}")
            for (remote, handler) in tailscale_tunnels.get("Web", {}).items():
                if not remote.endswith(":443"):
                    continue
                if handler != {'Handlers': {'/': {'Proxy': 'http://localhost:8000'}}}:
                    continue
                print(f"tailscale tunnel set up. Go to https://{remote.replace(":443", "")}/static/sixdofone.html?secret={SIXDOFONE_SHARED_SECRET}")
            else:
                assert False, "TODO: run `tailscale serve --bg localhost:8000` and print something useful here"

        except:
            pass

    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        print(f"connecting to {(os.environ.get("MYCOBOT_HOST"), int(os.environ.get("MYCOBOT_PORT", 9000)))}")
        MYCOBOT = MyCobotSocket(os.environ.get("MYCOBOT_HOST"), int(os.environ.get("MYCOBOT_PORT", 9000)))
        # MYCOBOT.release_all_servos()
        # sleep(1)
        # MYCOBOT.power_off()
        # sleep(1)
        # MYCOBOT.power_on()
        print(MYCOBOT.get_angles())

        MYCOBOT.send_coords(NEUTRAL_COORDS + pose_to_coord_offset(CURRENT_DRAG_POSE), 20)

    rr.init("sixdofone", spawn=True)
    CAP = cv2.VideoCapture(0)


    app.run(host="0.0.0.0", port=8000, debug=True)
