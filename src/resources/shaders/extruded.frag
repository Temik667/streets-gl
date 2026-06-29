#include <versionPrecision>
#include <gBufferOut>

#define WINDOW_GLOW_COLOR vec3(1, 0.9, 0.7)

in vec3 vColor;
in vec2 vUv;
in vec3 vNormal;
in vec3 vPosition;
flat in int vTextureId;
flat in uint vObjectId;
in vec4 vClipPos;
in vec4 vClipPosPrev;

uniform PerMesh {
    mat4 modelViewMatrix;
    mat4 modelViewMatrixPrev;
    uint tileId;
};

// CLEANED UP UBO
uniform PerMaterial {
    mat4 projectionMatrix;
    float windowLightThreshold;
    float u_errorNearClip;
    float u_errorFarClip;
    float u_planeTiltX;
    float u_planeTiltY;
};

uniform sampler2DArray tMap;
uniform sampler2D tNoise;

#include <packNormal>
#include <getMotionVector>
#include <getTBN>

vec4 getColorValue(int textureId, float mask, vec3 tintColor) {
    vec3 color = mix(vec3(1), tintColor, mask);
    return texture(tMap, vec3(vUv, textureId * 4)) * vec4(color, 1);
}

vec3 getMaskValue(int textureId) {
    return texture(tMap, vec3(vUv, textureId * 4 + 2)).xyz;
}

vec3 getGlowColor(int textureId) {
    return texture(tMap, vec3(vUv, textureId * 4 + 3)).xyz;
}

vec3 getNormalValue(int textureId) {
    mat3 tbn = getTBN(vNormal, vPosition, vec2(vUv.x, 1. - vUv.y));
    vec3 mapValue = texture(tMap, vec3(vUv, textureId * 4 + 1)).xyz * 2. - 1.;
    vec3 normal = normalize(tbn * mapValue);

    normal *= float(gl_FrontFacing) * 2. - 1.;

    return normal;
}

void main() {
    // 2. CALCULATE TILTED PLANAR DEPTH
    // -vPosition.z is the flat distance from the camera.
    // We add the X and Y coordinates multiplied by our tilt factors to slant the plane.
    float planarDepth = -vPosition.z + (vPosition.x * u_planeTiltX) + (vPosition.y * u_planeTiltY);

    // 3. EVALUATE CLIP
    if (planarDepth < u_errorNearClip || planarDepth > u_errorFarClip) {
        discard; 
    }

    vec3 mask = getMaskValue(vTextureId);
    float noiseTextureWidth = vec2(textureSize(tNoise, 0)).r;

    vec2 windowUV = vec2(
        floor((vUv.x + (floor(vUv.y) * 3.)) * 0.25),
        vUv.y
    ) / noiseTextureWidth;
    float windowNoise = texture(tNoise, windowUV).r;
    float glowFactor = 1.;
    float threshold = 1. - windowLightThreshold * 0.5;

    if (windowNoise <= threshold) {
        glowFactor = 0.;
    } else {
        glowFactor = fract(windowNoise * 10.) * 0.6 + 0.4;
    }

    outColor = getColorValue(vTextureId, mask.b, vColor);
    outGlow = getGlowColor(vTextureId) * WINDOW_GLOW_COLOR * glowFactor;
    outNormal = packNormal(getNormalValue(vTextureId));
    outRoughnessMetalnessF0 = vec3(mask.r, mask.g, 0.03);
    outMotion = getMotionVector(vClipPos, vClipPosPrev);
    
    if (!gl_FrontFacing) {
        outObjectId = 4294967295u; 
        outColor = vec4(1.0, 0.0, 1.0, 1.0); // Force the pixels to NEON PINK
    } else {
        outObjectId = vObjectId;
        // (Leave the standard outColor assignment above this block intact)
    }
}