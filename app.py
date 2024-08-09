from flask import Flask, send_from_directory, request, jsonify

app = Flask(__name__)


# Route to serve the HTML file
@app.route("/")
def index():
    return send_from_directory("static", "webxr_position_rotation.html")


# API endpoint to receive the position and rotation data
@app.route("/api/report", methods=["POST"])
def report():
    data = request.json
    # Process the data (e.g., save to a database, log, etc.)
    print(f"Received data: {data}")
    return jsonify({"status": "success"}), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
