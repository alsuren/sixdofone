import logging

from flask import Flask, request, jsonify, redirect
import rerun as rr
import numpy as np

app = Flask(__name__)


# Route to serve the HTML file
@app.route("/")
def index():
    return redirect("static/anchors.html")


# API endpoint to receive the position and rotation data
@app.route("/api/report", methods=["POST"])
def report():
    report_inner(request.json)

    return jsonify({"status": "success"}), 200


def report_inner(data):
    # e.g. {'position': {'x': 0, 'y': 0, 'z': 0}, 'orientation': {'x': 0, 'y': 0, 'z': 0, 'w': 1}}
    # FIXME: I have no idea what w is for. I should read the webxr docs.
    # FIXME: add some types to this mess.
    data = request.json

    if (
        data["position"]["x"] == 0
        and data["position"]["y"] == 0
        and data["position"]["z"] == 0
    ):
        # FIXME: We should probably filter this out in js-land instead.
        # Seems to happen when you exit out of the vr app/refresh?
        return

    print(f"got: {data}")

    forward_vector = np.array([0, 0, -1])
    rotation_matrix = quaternion_to_rotation_matrix(**data["orientation"])

    # Rotate the forward vector
    rotated_vector = np.dot(rotation_matrix, forward_vector)

    item = rr.Arrows3D(
        origins=[
            [
                data["position"]["x"],
                data["position"]["y"],
                data["position"]["z"],
            ]
        ],
        # position is in metres, and a 1m long arrow looks a bit silly in rerun.
        vectors=[rotated_vector * 0.1],
    )
    # FIXME: find a way to set "visible time range" programmatically to give us a tail of previous
    # arrows (probably by setting a blueprint on startup). For now I've been setting it up manually.
    rr.log("phone", item)


# More chatgpt nonsense because I don't want to bother adding more dependencies
def quaternion_to_rotation_matrix(w, x, y, z):
    """
    Convert a quaternion into a rotation matrix.
    """
    # Normalize the quaternion
    norm = np.sqrt(w**2 + x**2 + y**2 + z**2)
    w, x, y, z = w / norm, x / norm, y / norm, z / norm

    # Calculate elements of the rotation matrix
    matrix = np.array(
        [
            [1 - 2 * y**2 - 2 * z**2, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
            [2 * x * y + 2 * z * w, 1 - 2 * x**2 - 2 * z**2, 2 * y * z - 2 * x * w],
            [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x**2 - 2 * y**2],
        ]
    )

    return matrix


if __name__ == "__main__":
    rr.init("sixdofone", spawn=True)

    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    app.run(host="0.0.0.0", port=8000, debug=True)
