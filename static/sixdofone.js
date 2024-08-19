// @ts-check
// @ts-expect-error no type stubs for CDN things. Feels like there should be a way to fix this.
import { renderSVG } from 'https://cdn.jsdelivr.net/npm/uqr@0.1.2/+esm'

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
    new WebXRPolyfill();
}

// XR globals.
/** @type: WebXRButton | null */
let xrButton = null;
let xrImmersiveRefSpace = null;
let inlineViewerHelper = null;

let isARAvailable = false;
/** @type XRSessionMode */
let xrSessionString = 'immersive-vr';

/**
 * It turns out the browser mutates this in place, so  we can save this as a global and rely on
 * dragInputSource.gamepad.axes being updated ready for each frame callback.
 *
 * @type {XRInputSource | undefined}
 */
let dragInputSource = undefined;

/** @type {number[] | undefined} */
let dragStartGamepadAxes = undefined;
/** @type {XRViewerPose | "start" | undefined} */
let dragStartPose = undefined;

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

export function initXR() {
    const header = document.querySelector('header')
    if (!header) {
        throw new Error("missing <header> element")
    }

    const qrCodeSVG = renderSVG(window.location.href)
    console.log(qrCodeSVG)
    const svgDataUri = 'data:image/svg+xml;base64,' + btoa(qrCodeSVG);
    console.log(svgDataUri)
    const imgElement = document.createElement('img');
    imgElement.src = svgDataUri;
    imgElement.alt = 'QR Code';
    header.appendChild(imgElement);

    xrButton = new WebXRButton({
        onRequestSession: onRequestSession,
        onEndSession: onEndSession,
        textEnterXRTitle: isARAvailable ? "START AR" : "START VR",
        textXRNotFoundTitle: isARAvailable ? "AR NOT FOUND" : "VR NOT FOUND",
        textExitXRTitle: isARAvailable ? "EXIT  AR" : "EXIT  VR",
    });
    header.appendChild(xrButton.domElement);

    if (navigator.xr) {
        // Checks to ensure that 'immersive-ar' or 'immersive-vr' mode is available,
        // and only enables the button if so.
        navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
            isARAvailable = supported;
            xrButton.enabled = supported;
            if (supported) {
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
    session.addEventListener('selectstart', onSelect);
    session.addEventListener('selectend', onSelect)

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


/**
 * @param { XRSession } session
 */
function onEndSession(session) {
    session.end();
}

/**
 * @param { XRSessionEvent } event
 */
function onSessionEnded(event) {
    // @ts-expect-error anchors.html example squirrels away isImmersive on `session` : -(
    if (event.session.isImmersive) {
        xrButton.setSession(null);
        // Turn the background back on when we go back to the in live view.
        skybox.visible = true;
    }
}

/** @type {(this: XRSession, ev: XRInputSourceEvent) => any} */
function onSelect(event) {
    if (event.type == 'selectstart') {
        dragInputSource = event.inputSource
        dragStartGamepadAxes = [...dragInputSource?.gamepad?.axes ?? []]
        // We can't frame.getViewerPose() here because we're not in a requestAnimationFrame callback,
        // so we set a sentinel and let it happen next time we are.
        dragStartPose = "start";
    }
    else if (event.type == 'selectend') {
        dragStartPose = undefined;
    }
}

/** @type XRFrameRequestCallback */
// Called every time a XRSession requests that a new frame be drawn.
function onXRFrame(t, frame) {
    let session = frame.session;
    // @ts-expect-error anchors.html example squirrels away isImmersive on `session` : -(
    let xrRefSpace = session.isImmersive ?
        xrImmersiveRefSpace :
        inlineViewerHelper.referenceSpace;
    let pose = frame.getViewerPose(xrRefSpace);

    // @ts-expect-error this isImmersive is my fault. I think I might just make a single god object
    // and pass all of my state around using that rather than shoving it on `session`?
    if (session.isImmersive) {
        // FIXME: this pile of functions rely on a lot of global variables.
        reportPoseIfNeeded(t, pose);
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

/**
 * @param {number} t
 * @param {XRViewerPose | undefined} pose
 */
function reportPoseIfNeeded(t, pose) {
    if (pose && (t - lastSendTime > sendInterval)) {
        sendData(pose);
        lastSendTime = t;
    }
}

/**
 * @param { XRViewerPose } pose
 */
function sendData(pose) {
    if (dragStartPose == "start") {
        dragStartPose = pose;
        // recurse to make it easier for typescript to reason about the types below
        return sendData(pose)
    }

    fetchSerialized('/api/report', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            position: { x: pose.transform.position.x, y: pose.transform.position.y, z: pose.transform.position.z },
            orientation: { x: pose.transform.orientation.x, y: pose.transform.orientation.y, z: pose.transform.orientation.z, w: pose.transform.orientation.w },
            gamepadAxes: dragInputSource?.gamepad?.axes,
            dragStartPosition: dragStartPose && { x: dragStartPose.transform.position.x, y: dragStartPose.transform.position.y, z: dragStartPose.transform.position.z },
            dragStartOrientation: dragStartPose && { x: dragStartPose.transform.orientation.x, y: dragStartPose.transform.orientation.y, z: dragStartPose.transform.orientation.z, w: dragStartPose.transform.orientation.w },
            dragStartGamepadAxes,
        })
    }).then(response => response?.json())
        .then(data => data ? console.log('Pose data sent successfully') : console.log('Skipped sending pose'))
        .catch(error => console.error('Failed to send pose data:', error));
}

/** @type Promise<Response> | null */
let fetchInFlight = null
/**
 * Calls fetch() but only if there is not already a fetch() call in flight
 *
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<Response | null>}
 */
async function fetchSerialized(url, init) {
    if (fetchInFlight) {
        return null
    }
    fetchInFlight = fetchSigned(url, init)
    const response = await fetchInFlight;
    fetchInFlight = null
    return response
}

/**
 * Calls fetch() but adds HMAC signature based on ?secret= param if it exists.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
async function fetchSigned(url, init) {
    const secret = new URLSearchParams(window.location.search).get("secret")
    if (!secret) {
        return fetch(url, init)
    }
    if (typeof init.body !== 'string') {
        throw new Error("Unexpected body. Expected string.")
    }

    const signature = await generateHMAC(secret, init.body)
    init.headers = {
        ...init.headers,
        ...{
            'Content-Type': 'application/json',
            'Authorization': `HMAC ${signature}`
        }
    }

    return fetch(url, init)
}

/**
 * @param {string} secret
 * @param {string} payload
 * @returns {Promise<string>} hmac token
 */
async function generateHMAC(secret, payload) {
    const encoder = new TextEncoder();
    const key = await window.crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signature = await window.crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(payload)
    );

    // Convert signature to hexadecimal string
    return Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}
