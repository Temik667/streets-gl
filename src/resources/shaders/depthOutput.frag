#include <versionPrecision>

out float FragColor;

in vec2 vUv;

uniform sampler2D tDepth;

uniform MainBlock {
    mat4 projectionMatrixInverse;
};

#include <reconstructPositionFromDepth>

void main() {
    float rawDepth = texture(tDepth, vUv).r;
    vec3 viewPosition = reconstructPositionFromDepth(vUv, rawDepth, projectionMatrixInverse);

    // View space looks down -Z, so the linear distance from the camera
    // along the view axis (the conventional "depth" value) is -viewPosition.z.
    FragColor = -viewPosition.z;
}