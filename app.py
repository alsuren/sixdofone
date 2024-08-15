import logging
from dataclasses import dataclass, field
from typing import Literal


from flask import Flask, request, jsonify, redirect
import rerun as rr
import numpy as np
import cv2
from pyquaternion import Quaternion

app = Flask(__name__)


@dataclass
class Pose:
    position: np.array
    orientation: Quaternion


def pose_from_webxr(
    position: dict[Literal["x"] | Literal["y"] | Literal["x"], float],
    orientation: dict[Literal["w"] | Literal["x"] | Literal["y"] | Literal["x"], float],
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
    )


# position is in metres, and a 1m long arrow looks a bit silly in rerun.
SHORT_FORWARD_VECTOR = np.array([0, 0, -0.1])

CURRENTLY_DRAGGING = False
PREVIOUS_POSE = Pose(
    position=np.array([0, 0, 0]),
    orientation=Quaternion(axis=[1.0, 0.0, 0.0], degrees=90),
)
PREVIOUS_DRAG_END_POSE = Pose(
    position=np.array([0, 0, 0]),
    orientation=Quaternion(axis=[1.0, 0.0, 0.0], degrees=90),
)
CURRENT_DRAG_POSE = Pose(
    position=np.array([0, 0, 0]),
    orientation=Quaternion(axis=[1.0, 0.0, 0.0], degrees=90),
)


# Route to serve the HTML file
@app.route("/")
def index():
    return redirect("static/sixdofone.html")


# API endpoint to receive the position and rotation data
@app.route("/api/report", methods=["POST"])
def report():
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

    print(f"got: {data}")

    pose = pose_from_webxr(
        data["position"],
        data["orientation"],
    )
    if data.get("dragStartPosition") and data.get("dragStartOrientation"):
        CURRENTLY_DRAGGING = True
        drag_start_pose = pose_from_webxr(
            data["dragStartPosition"], data["dragStartOrientation"]
        )

        CURRENT_DRAG_POSE = Pose(
            PREVIOUS_DRAG_END_POSE.position - drag_start_pose.position + pose.position,
            pose.orientation
            * drag_start_pose.orientation.conjugate
            * PREVIOUS_DRAG_END_POSE.orientation,
        )
        rr.log(
            "phone/drag",
            rr.Arrows3D(
                origins=[CURRENT_DRAG_POSE.position],
                vectors=[CURRENT_DRAG_POSE.orientation.rotate(SHORT_FORWARD_VECTOR)],
            ),
        )
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


if __name__ == "__main__":
    logging.getLogger("werkzeug").setLevel(logging.ERROR)

    rr.init("sixdofone", spawn=True)
    CAP = cv2.VideoCapture(0)

    app.run(host="0.0.0.0", port=8000, debug=True)
