// @ts-check
import { WebXRButton } from './js/util/webxr-button.js';
import { Scene } from './js/render/scenes/scene.js';
import { Renderer, createWebGLContext } from './js/render/core/renderer.js';
import { SkyboxNode } from './js/render/nodes/skybox.js';
import { InlineViewerHelper } from './js/util/inline-viewer-helper.js';
import { Gltf2Node } from './js/render/nodes/gltf2.js';
import { QueryArgs } from './js/util/query-args.js';

// If requested, use the polyfill to provide support for mobile devices
// and devices which only support WebVR.
import WebXRPolyfill from './js/third-party/webxr-polyfill/build/webxr-polyfill.module.js';
if (QueryArgs.getBool('usePolyfill', true)) {
    let polyfill = new WebXRPolyfill();
}

// XR globals.
/** @type: WebXRButton | null */
let xrButton = null;
let xrImmersiveRefSpace = null;
let inlineViewerHelper = null;

let isARAvailable = false;
let isVRAvailable = false;
/** @type XRSessionMode */
let xrSessionString = 'immersive-vr';

// WebGL scene globals.
let gl = null;
let renderer = null;
let scene = new Scene();
let solarSystem = new Gltf2Node({ url: 'media/gltf/space/space.gltf' });
// The solar system is big (citation needed). Scale it down so that users
// can move around the planets more easily.
solarSystem.scale = [0.1, 0.1, 0.1];
scene.addNode(solarSystem);
// Still adding a skybox, but only for the benefit of the inline view.
let skybox = new SkyboxNode({ url: 'media/textures/milky-way-4k.png' });
scene.addNode(skybox);

const MAX_ANCHORED_OBJECTS = 30;
let anchoredObjects = [];

// Set with all anchors tracked in a previous frame.
let all_previous_anchors = new Set();

export function initXR() {
    xrButton = new WebXRButton({
        onRequestSession: onRequestSession,
        onEndSession: onEndSession,
        textEnterXRTitle: isARAvailable ? "START AR" : "START VR",
        textXRNotFoundTitle: isARAvailable ? "AR NOT FOUND" : "VR NOT FOUND",
        textExitXRTitle: isARAvailable ? "EXIT  AR" : "EXIT  VR",
    });
    document.querySelector('header')?.appendChild(xrButton.domElement);

    if (navigator.xr) {
        // Checks to ensure that 'immersive-ar' or 'immersive-vr' mode is available,
        // and only enables the button if so.
        navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
            isARAvailable = supported;
            xrButton.enabled = supported;
            if (!supported) {
                navigator.xr?.isSessionSupported('immersive-vr').then((supported) => {
                    isVRAvailable = supported;
                    xrButton.enabled = supported;
                });
            } else {
                xrSessionString = 'immersive-ar';
            }
        });

        navigator.xr.requestSession('inline').then(onSessionStarted);
    }
}

function onRequestSession() {
    // Requests an 'immersive-ar' or 'immersive-vr' session, depending on which is supported,
    // and requests the 'anchors' module as a required feature.
    return navigator.xr?.requestSession(xrSessionString, { requiredFeatures: ['anchors'] })
        .then((session) => {
            if (!session) throw new Error("expected session")
            xrButton.setSession(session);
            // @ts-expect-error anchors.html example squirrels away isImmersive on `session` :-(
            session.isImmersive = true;
            onSessionStarted(session);
        });
}

function initGL() {
    if (gl)
        return;

    gl = createWebGLContext({
        xrCompatible: true
    });
    if (!gl) throw new Error("gl expected");

    document.body.appendChild(/** @type HTMLCanvasElement */(gl.canvas));

    function onResize() {
        gl.canvas.width = gl.canvas.clientWidth * window.devicePixelRatio;
        gl.canvas.height = gl.canvas.clientHeight * window.devicePixelRatio;
    }
    window.addEventListener('resize', onResize);
    onResize();

    renderer = new Renderer(gl);

    scene.setRenderer(renderer);
}

/**
 * @param session {XRSession}
 */
function onSessionStarted(session) {
    session.addEventListener('end', onSessionEnded);
    session.addEventListener('select', onSelect);

    // @ts-expect-error anchors.html example squirrels away isImmersive on `session` : -(
    if (session.isImmersive && isARAvailable) {
        // When in 'immersive-ar' mode don't draw an opaque background because
        // we want the real world to show through.
        skybox.visible = false;
    }

    initGL();

    // This and all future samples that visualize controllers will use this
    // convenience method to listen for changes to the active XRInputSources
    // and load the right meshes based on the profiles array.
    scene.inputRenderer.useProfileControllerMeshes(session);

    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });

    /** @type {'local' | 'viewer'} */
    // @ts-expect-error anchors.html example squirrels away isImmersive on `session` : -(
    let refSpaceType = session.isImmersive ? 'local' : 'viewer';
    session.requestReferenceSpace(refSpaceType).then((refSpace) => {
        // @ts-expect-error anchors.html example squirrels away isImmersive on `session` : -(
        if (session.isImmersive) {
            xrImmersiveRefSpace = refSpace;
        } else {
            inlineViewerHelper = new InlineViewerHelper(gl.canvas, refSpace);
        }
        session.requestAnimationFrame(onXRFrame);
    });
}

function onEndSession(session) {
    session.end();
}

function onSessionEnded(event) {
    if (event.session.isImmersive) {
        xrButton.setSession(null);
        // Turn the background back on when we go back to the in live view.
        skybox.visible = true;
    }
}

function addAnchoredObjectToScene(anchor) {
    console.debug("Anchor created");

    anchor.context = {};

    let flower = new Gltf2Node({ url: 'media/gltf/sunflower/sunflower.gltf' });
    scene.addNode(flower);
    anchor.context.sceneObject = flower;
    // @ts-expect-error anchors.html example squirrels away .anchor on `flower` : -(
    flower.anchor = anchor;
    anchoredObjects.push(flower);

    // For performance reasons if we add too many objects start
    // removing the oldest ones to keep the scene complexity
    // from growing too much.
    if (anchoredObjects.length > MAX_ANCHORED_OBJECTS) {
        let objectToRemove = anchoredObjects.shift();
        scene.removeNode(objectToRemove);
        objectToRemove.anchor.delete();
    }
}

function onSelect(event) {
    let frame = event.frame;
    let session = frame.session;
    let anchorPose = new XRRigidTransform();
    let inputSource = event.inputSource;

    // If the user is on a screen based device, place the anchor 1 meter in front of them.
    // Otherwise place the anchor at the location of the input device
    if (inputSource.targetRayMode == 'screen') {
        anchorPose = new XRRigidTransform(
            { x: 0, y: 0, z: -1 },
            { x: 0, y: 0, z: 0, w: 1 });
    }

    if (session.isImmersive) {
        // Create a free-floating anchor.
        frame.createAnchor(anchorPose, inputSource.targetRaySpace).then((anchor) => {
            addAnchoredObjectToScene(anchor);
        }, (error) => {
            console.error("Could not create anchor: " + error);
        });
    }
}

// Called every time a XRSession requests that a new frame be drawn.
function onXRFrame(t, frame) {
    let session = frame.session;
    let xrRefSpace = session.isImmersive ?
        xrImmersiveRefSpace :
        inlineViewerHelper.referenceSpace;
    let pose = frame.getViewerPose(xrRefSpace);


    reportPoseIfNeeded(t, pose);

    // Update the position of all the anchored objects based on the currently reported positions of their anchors
    const tracked_anchors = frame.trackedAnchors;
    if (tracked_anchors) {
        all_previous_anchors.forEach(anchor => {
            if (!tracked_anchors.has(anchor)) {
                scene.removeNode(anchor.sceneObject);
            }
        });

        tracked_anchors.forEach(anchor => {
            const anchorPose = frame.getPose(anchor.anchorSpace, xrRefSpace);
            if (anchorPose) {
                anchor.context.sceneObject.matrix = anchorPose.transform.matrix;
                anchor.context.sceneObject.visible = true;
            } else {
                anchor.context.sceneObject.visible = false;
            }
        });

        all_previous_anchors = tracked_anchors;
    } else {
        all_previous_anchors.forEach(anchor => {
            scene.removeNode(anchor.sceneObject);
        });

        all_previous_anchors = new Set();
    }

    // In this sample and most samples after it we'll use a helper function
    // to automatically add the right meshes for the session's input sources
    // each frame. This also does simple hit detection to position the
    // cursors correctly on the surface of selectable nodes.
    scene.updateInputSources(frame, xrRefSpace);

    scene.startFrame();

    session.requestAnimationFrame(onXRFrame);

    scene.drawXRFrame(frame, pose);

    scene.endFrame();
}



// Initialize variables
let lastSendTime = performance.now();
const sendInterval = 100; // Time in milliseconds

function reportPoseIfNeeded(t, pose) {
    if (pose && (t - lastSendTime > sendInterval)) {
        sendData(pose);
        lastSendTime = t;
    }
}

function sendData(pose) {
    fetch('/api/report', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            position: { x: pose.transform.position.x, y: pose.transform.position.y, z: pose.transform.position.z },
            orientation: { x: pose.transform.orientation.x, y: pose.transform.orientation.y, z: pose.transform.orientation.z, w: pose.transform.orientation.w }
        })
    }).then(response => response.json())
        .then(data => console.log('Pose data sent successfully'))
        .catch(error => console.error('Failed to send pose data:', error));
}
