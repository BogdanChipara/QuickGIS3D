let visibleTilesMap = new Map();
let trackingInstalled = false;

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let exportProgressClearTimer = null;

function setExportProgress(percent) {
  const el = document.getElementById("exportProgress");
  if (!el) return;

  if (exportProgressClearTimer) {
    clearTimeout(exportProgressClearTimer);
    exportProgressClearTimer = null;
  }

  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  el.textContent = `Export: ${safePercent}%`;
}

function clearExportProgress() {
  const el = document.getElementById("exportProgress");
  if (!el) return;
  el.textContent = "";
}

function completeExportProgress() {
  setExportProgress(100);
  exportProgressClearTimer = setTimeout(() => {
    clearExportProgress();
    exportProgressClearTimer = null;
  }, 1200);
}

function failExportProgress() {
  const el = document.getElementById("exportProgress");
  if (!el) return;

  if (exportProgressClearTimer) {
    clearTimeout(exportProgressClearTimer);
    exportProgressClearTimer = null;
  }

  el.textContent = "Export failed";
  exportProgressClearTimer = setTimeout(() => {
    clearExportProgress();
    exportProgressClearTimer = null;
  }, 2200);
}

function createChunkedYieldController(options = {}) {
  const {
    timeBudgetMs = 12,
    maxOpsBeforeYield = 20
  } = options;

  let opCount = 0;
  let lastYieldTime = performance.now();

  return {
    async maybeYield(force = false) {
      opCount++;
      const now = performance.now();

      if (!force && opCount < maxOpsBeforeYield && (now - lastYieldTime) < timeBudgetMs) {
        return;
      }

      opCount = 0;

      await new Promise((resolve) => {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 0);
        }
      });

      lastYieldTime = performance.now();
    }
  };
}

function installVisibleTileTracking() {
  const viewer = window.cesiumViewer;
  const tileset = window.osmBuildingsTileset;

  if (!viewer || !tileset) return false;
  if (trackingInstalled) return true;

  viewer.scene.preRender.addEventListener(() => {
    visibleTilesMap.clear();
  });

  tileset.tileVisible.addEventListener((tile) => {
    if (!tile || !tile.content) return;

    const key =
      tile.content.url ||
      tile._header?.content?.uri ||
      `tile_${tile._contentState || ""}_${Math.random().toString(36).slice(2)}`;

    visibleTilesMap.set(key, tile);
  });

  trackingInstalled = true;
  console.log("Visible tile tracking installed.");
  return true;
}

function getDrawCommandsFromModel(model) {
  if (!model) return [];
  return model._drawCommands || model._nodeCommands || model._commands || [];
}

function getVertexArrayFromCommand(cmd) {
  return cmd?.vertexArray || cmd?._vertexArray || null;
}

function getAttributesFromVertexArray(vao) {
  if (!vao) return [];
  return vao._attributes || vao.attributes || [];
}

function getIndexBufferFromVertexArray(vao) {
  if (!vao) return null;
  return vao.indexBuffer || vao._indexBuffer || null;
}

function getPositionAttribute(attributes) {
  if (!attributes || !attributes.length) return null;

  for (const a of attributes) {
    if (a?.index === 0) return a;
  }

  for (const a of attributes) {
    const name = String(a?.name || a?._name || a?.semantic || "").toUpperCase();
    if (name.includes("POSITION")) return a;
  }

  return null;
}

function tryGetArrayBufferFromCesiumBuffer(bufferObj, gl, target) {
  if (!bufferObj) return null;

  if (bufferObj._arrayBuffer) return bufferObj._arrayBuffer;
  if (bufferObj.arrayBuffer) return bufferObj.arrayBuffer;
  if (bufferObj._buffer && bufferObj._buffer._arrayBuffer) return bufferObj._buffer._arrayBuffer;

  // Fallback for Cesium buffers that only exist on GPU.
  // Works in WebGL2 (Cesium 1.139+ default).
  if (!gl || !target || typeof gl.getBufferSubData !== "function") return null;

  const webglBuffer = bufferObj._buffer || bufferObj.buffer || null;
  const sizeInBytes = bufferObj.sizeInBytes || bufferObj._sizeInBytes || 0;

  if (!webglBuffer || !sizeInBytes) return null;

  const bindingParam =
    target === gl.ARRAY_BUFFER ? gl.ARRAY_BUFFER_BINDING : gl.ELEMENT_ARRAY_BUFFER_BINDING;

  const prevBinding = gl.getParameter(bindingParam);
  const out = new Uint8Array(sizeInBytes);

  try {
    gl.bindBuffer(target, webglBuffer);
    gl.getBufferSubData(target, 0, out);
  } catch (e) {
    try {
      gl.bindBuffer(target, prevBinding);
    } catch (_ignored) {}
    return null;
  }

  try {
    gl.bindBuffer(target, prevBinding);
  } catch (_ignored) {}

  return out.buffer;
}

function readComponent(dataView, byteOffset, componentDatatype) {
  switch (componentDatatype) {
    case 5120:
      return dataView.getInt8(byteOffset);
    case 5121:
      return dataView.getUint8(byteOffset);
    case 5122:
      return dataView.getInt16(byteOffset, true);
    case 5123:
      return dataView.getUint16(byteOffset, true);
    case 5124:
      return dataView.getInt32(byteOffset, true);
    case 5125:
      return dataView.getUint32(byteOffset, true);
    case 5126:
      return dataView.getFloat32(byteOffset, true);
    default:
      return null;
  }
}

function componentByteSize(componentDatatype) {
  switch (componentDatatype) {
    case 5120:
    case 5121:
      return 1;
    case 5122:
    case 5123:
      return 2;
    case 5124:
    case 5125:
    case 5126:
      return 4;
    default:
      return 0;
  }
}

function decodePositionsFromAttribute(positionAttr, vao, gl) {
  if (!positionAttr) return null;

  const vb =
    positionAttr.vertexBuffer ||
    positionAttr._vertexBuffer ||
    positionAttr.buffer ||
    null;

  const posBuffer = tryGetArrayBufferFromCesiumBuffer(vb, gl, gl?.ARRAY_BUFFER);
  if (!posBuffer) return null;

  const componentDatatype = positionAttr.componentDatatype || 5126;
  const componentSize = componentByteSize(componentDatatype);
  const componentsPerAttribute = positionAttr.componentsPerAttribute || 3;
  if (!componentSize || componentsPerAttribute < 3) return null;

  const offsetInBytes = positionAttr.offsetInBytes || 0;
  const strideInBytes =
    positionAttr.strideInBytes ||
    componentsPerAttribute * componentSize;

  let count = positionAttr.count;
  if (!count || count <= 0) {
    const numVerts = vao?.numberOfVertices || vao?._numberOfVertices;
    if (numVerts && numVerts > 0) {
      count = numVerts;
    } else {
      count = Math.floor((posBuffer.byteLength - offsetInBytes) / strideInBytes);
    }
  }

  if (!count || count <= 0) return null;

  const dv = new DataView(posBuffer);
  const out = new Float64Array(count * 3);

  for (let i = 0; i < count; i++) {
    const base = offsetInBytes + i * strideInBytes;
    const x = readComponent(dv, base, componentDatatype);
    const y = readComponent(dv, base + componentSize, componentDatatype);
    const z = readComponent(dv, base + componentSize * 2, componentDatatype);

    if (x === null || y === null || z === null) return null;

    out[i * 3 + 0] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }

  return out;
}

function decodeIndices(indexBuffer, gl, vertexCount) {
  if (!indexBuffer || !gl) return null;

  const ib = tryGetArrayBufferFromCesiumBuffer(indexBuffer, gl, gl.ELEMENT_ARRAY_BUFFER);
  if (!ib) return null;

  const datatype = indexBuffer.indexDatatype || indexBuffer._indexDatatype;

  if (datatype === 5125) return new Uint32Array(ib);
  if (datatype === 5123) return new Uint16Array(ib);
  if (datatype === 5121) return new Uint8Array(ib);

  // Fallback guess by vertex count and byte size.
  if (vertexCount > 65535 && ib.byteLength % 4 === 0) return new Uint32Array(ib);
  if (ib.byteLength % 2 === 0) return new Uint16Array(ib);
  return new Uint8Array(ib);
}

function appendFaces(obj, indices, primitiveType, vertexOffset, vertexCount) {
  // TRIANGLES
  if (primitiveType === Cesium.PrimitiveType.TRIANGLES || primitiveType === undefined || primitiveType === null) {
    const src = indices || null;

    if (src && src.length >= 3) {
      for (let i = 0; i + 2 < src.length; i += 3) {
        const a = src[i + 0] + 1 + vertexOffset;
        const b = src[i + 1] + 1 + vertexOffset;
        const c = src[i + 2] + 1 + vertexOffset;
        obj.push(`f ${a} ${b} ${c}`);
      }
      return;
    }

    for (let i = 0; i + 2 < vertexCount; i += 3) {
      obj.push(`f ${i + 1 + vertexOffset} ${i + 2 + vertexOffset} ${i + 3 + vertexOffset}`);
    }
    return;
  }

  // TRIANGLE_STRIP
  if (primitiveType === Cesium.PrimitiveType.TRIANGLE_STRIP && indices && indices.length >= 3) {
    for (let i = 0; i + 2 < indices.length; i++) {
      const i0 = indices[i + 0];
      const i1 = indices[i + 1];
      const i2 = indices[i + 2];
      if (i % 2 === 0) {
        obj.push(`f ${i0 + 1 + vertexOffset} ${i1 + 1 + vertexOffset} ${i2 + 1 + vertexOffset}`);
      } else {
        obj.push(`f ${i1 + 1 + vertexOffset} ${i0 + 1 + vertexOffset} ${i2 + 1 + vertexOffset}`);
      }
    }
  }
}

function getTileContentUrl(tile, tileset) {
  const content = tile?.content;
  const raw =
    content?.url ||
    content?._resource?.url ||
    tile?._contentResource?.url ||
    tile?._header?.content?.uri ||
    null;

  if (!raw) return null;

  try {
    const base = tileset?._resource?.url || document.baseURI;
    return new URL(raw, base).toString();
  } catch (_ignored) {
    return raw;
  }
}

async function fetchArrayBufferWithCesium(url) {
  if (!url) return null;

  try {
    if (Cesium?.Resource?.createIfNeeded) {
      const resource = Cesium.Resource.createIfNeeded(url);
      const data = await resource.fetchArrayBuffer();
      if (data) return data;
    }
  } catch (_ignored) {}

  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`HTTP ${r.status} for ${url}`);
  }
  return await r.arrayBuffer();
}

function decodeTextFromSlice(buffer, byteOffset, byteLength) {
  if (!byteLength) return "";
  const slice = buffer.slice(byteOffset, byteOffset + byteLength);
  let text = new TextDecoder().decode(slice);
  text = text.replace(/\u0000+$/g, "").trim();
  return text;
}

function parseB3dmOrGlb(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 12) {
    return { glbBuffer: null, rtcCenter: null };
  }

  const dv = new DataView(arrayBuffer);
  const magic = String.fromCharCode(
    dv.getUint8(0),
    dv.getUint8(1),
    dv.getUint8(2),
    dv.getUint8(3)
  );

  // Raw GLB
  if (magic === "glTF") {
    return { glbBuffer: arrayBuffer, rtcCenter: null };
  }

  // b3dm
  if (magic !== "b3dm" || arrayBuffer.byteLength < 28) {
    return { glbBuffer: null, rtcCenter: null };
  }

  const byteLength = dv.getUint32(8, true);
  const featureTableJsonByteLength = dv.getUint32(12, true);
  const featureTableBinaryByteLength = dv.getUint32(16, true);
  const batchTableJsonByteLength = dv.getUint32(20, true);
  const batchTableBinaryByteLength = dv.getUint32(24, true);

  const ftJsonOffset = 28;
  const glbOffset =
    28 +
    featureTableJsonByteLength +
    featureTableBinaryByteLength +
    batchTableJsonByteLength +
    batchTableBinaryByteLength;

  if (glbOffset >= arrayBuffer.byteLength) {
    return { glbBuffer: null, rtcCenter: null };
  }

  let rtcCenter = null;
  try {
    const ftJsonText = decodeTextFromSlice(arrayBuffer, ftJsonOffset, featureTableJsonByteLength);
    if (ftJsonText) {
      const ftJson = JSON.parse(ftJsonText);
      if (Array.isArray(ftJson?.RTC_CENTER) && ftJson.RTC_CENTER.length >= 3) {
        rtcCenter = [
          Number(ftJson.RTC_CENTER[0]) || 0,
          Number(ftJson.RTC_CENTER[1]) || 0,
          Number(ftJson.RTC_CENTER[2]) || 0
        ];
      }
    }
  } catch (_ignored) {}

  const finalLength = Math.min(byteLength || arrayBuffer.byteLength, arrayBuffer.byteLength);
  const glbBuffer = arrayBuffer.slice(glbOffset, finalLength);
  return { glbBuffer, rtcCenter };
}

function parseGlb(glbBuffer) {
  if (!glbBuffer || glbBuffer.byteLength < 20) {
    return { gltf: null, binChunk: null };
  }

  const dv = new DataView(glbBuffer);
  const magic = dv.getUint32(0, true);
  if (magic !== 0x46546c67) {
    return { gltf: null, binChunk: null };
  }

  let offset = 12;
  let gltf = null;
  let binChunk = null;

  while (offset + 8 <= glbBuffer.byteLength) {
    const chunkLength = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    const chunkDataEnd = chunkDataOffset + chunkLength;
    if (chunkDataEnd > glbBuffer.byteLength) break;

    if (chunkType === 0x4e4f534a) {
      const jsonText = decodeTextFromSlice(glbBuffer, chunkDataOffset, chunkLength);
      if (jsonText) {
        gltf = JSON.parse(jsonText);
      }
    } else if (chunkType === 0x004e4942) {
      binChunk = glbBuffer.slice(chunkDataOffset, chunkDataEnd);
    }

    offset = chunkDataEnd;
  }

  return { gltf, binChunk };
}

function gltfNumComponents(type) {
  switch (type) {
    case "SCALAR":
      return 1;
    case "VEC2":
      return 2;
    case "VEC3":
      return 3;
    case "VEC4":
      return 4;
    case "MAT2":
      return 4;
    case "MAT3":
      return 9;
    case "MAT4":
      return 16;
    default:
      return 0;
  }
}

function normalizeInteger(value, componentType) {
  switch (componentType) {
    case 5120:
      return Math.max(value / 127, -1);
    case 5121:
      return value / 255;
    case 5122:
      return Math.max(value / 32767, -1);
    case 5123:
      return value / 65535;
    case 5124:
      return Math.max(value / 2147483647, -1);
    case 5125:
      return value / 4294967295;
    default:
      return value;
  }
}

function readAccessorValues(gltf, binChunk, accessorIndex) {
  const accessor = gltf?.accessors?.[accessorIndex];
  if (!accessor) return null;

  const bufferView = gltf?.bufferViews?.[accessor.bufferView];
  if (!bufferView || !binChunk) return null;

  const numComponents = gltfNumComponents(accessor.type || "SCALAR");
  if (!numComponents) return null;

  const compSize = componentByteSize(accessor.componentType);
  if (!compSize) return null;

  const count = accessor.count || 0;
  if (!count) return null;

  const stride = bufferView.byteStride || numComponents * compSize;
  const baseOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);

  if (baseOffset >= binChunk.byteLength) return null;

  const dv = new DataView(binChunk);
  const out = new Float64Array(count * numComponents);

  for (let i = 0; i < count; i++) {
    const itemOffset = baseOffset + i * stride;
    for (let c = 0; c < numComponents; c++) {
      const at = itemOffset + c * compSize;
      if (at + compSize > binChunk.byteLength) return null;

      let value = readComponent(dv, at, accessor.componentType);
      if (value === null) return null;

      if (accessor.normalized) {
        value = normalizeInteger(value, accessor.componentType);
      }

      out[i * numComponents + c] = value;
    }
  }

  return {
    values: out,
    count,
    numComponents,
    accessor
  };
}

function makeNodeLocalMatrix(node) {
  if (Array.isArray(node?.matrix) && node.matrix.length === 16) {
    return Cesium.Matrix4.fromArray(node.matrix, 0, new Cesium.Matrix4());
  }

  const t = node?.translation || [0, 0, 0];
  const r = node?.rotation || [0, 0, 0, 1];
  const s = node?.scale || [1, 1, 1];

  const trs = new Cesium.TranslationRotationScale();
  trs.translation = new Cesium.Cartesian3(t[0], t[1], t[2]);
  trs.rotation = new Cesium.Quaternion(r[0], r[1], r[2], r[3]);
  trs.scale = new Cesium.Cartesian3(s[0], s[1], s[2]);

  return Cesium.Matrix4.fromTranslationRotationScale(trs, new Cesium.Matrix4());
}

function getAxisCorrectionMatrix(upAxis, forwardAxis) {
  const Axis = Cesium.Axis;
  if (!Axis) {
    return Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY, new Cesium.Matrix4());
  }

  let result = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY, new Cesium.Matrix4());

  if (upAxis === Axis.Y) {
    result = Cesium.Matrix4.clone(Axis.Y_UP_TO_Z_UP, result);
  } else if (upAxis === Axis.X) {
    result = Cesium.Matrix4.clone(Axis.X_UP_TO_Z_UP, result);
  }

  if (forwardAxis === Axis.Z) {
    result = Cesium.Matrix4.multiplyTransformation(result, Axis.Z_UP_TO_X_UP, result);
  }

  return result;
}

function getTilesetAxisCorrectionMatrix(tileset) {
  const Axis = Cesium.Axis;
  if (!Axis) {
    return Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY, new Cesium.Matrix4());
  }

  const upAxis = tileset?._modelUpAxis ?? Axis.Y;
  const forwardAxis = tileset?._modelForwardAxis ?? Axis.X;
  return getAxisCorrectionMatrix(upAxis, forwardAxis);
}

function getGltfRtcCenter(gltf) {
  const center = gltf?.extensions?.CESIUM_RTC?.center;
  if (!Array.isArray(center) || center.length < 3) {
    return null;
  }

  return new Cesium.Cartesian3(
    Number(center[0]) || 0,
    Number(center[1]) || 0,
    Number(center[2]) || 0
  );
}

function getContentTransform(parsedTileRtcCenter, gltf) {
  let result = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY, new Cesium.Matrix4());

  if (Array.isArray(parsedTileRtcCenter) && parsedTileRtcCenter.length >= 3) {
    result = Cesium.Matrix4.fromTranslation(
      new Cesium.Cartesian3(
        Number(parsedTileRtcCenter[0]) || 0,
        Number(parsedTileRtcCenter[1]) || 0,
        Number(parsedTileRtcCenter[2]) || 0
      ),
      result
    );
  }

  const gltfRtcCenter = getGltfRtcCenter(gltf);
  if (gltfRtcCenter) {
    result = Cesium.Matrix4.multiplyTransformation(
      result,
      Cesium.Matrix4.fromTranslation(gltfRtcCenter, new Cesium.Matrix4()),
      result
    );
  }

  return result;
}

function buildNodeWorldMatrices(gltf) {
  const nodes = gltf?.nodes || [];
  const scenes = gltf?.scenes || [];
  const sceneIndex = gltf?.scene || 0;
  const rootScene = scenes[sceneIndex] || scenes[0] || { nodes: [] };
  const worldByNode = new Array(nodes.length);

  function walk(nodeIndex, parentWorld) {
    const node = nodes[nodeIndex];
    if (!node) return;

    const local = makeNodeLocalMatrix(node);
    const world = Cesium.Matrix4.multiply(parentWorld, local, new Cesium.Matrix4());
    worldByNode[nodeIndex] = world;

    const children = node.children || [];
    for (const childIndex of children) {
      walk(childIndex, world);
    }
  }

  const identity = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY, new Cesium.Matrix4());
  for (const rootNodeIndex of rootScene.nodes || []) {
    walk(rootNodeIndex, identity);
  }

  // Unreachable nodes fallback
  for (let i = 0; i < nodes.length; i++) {
    if (!worldByNode[i]) {
      worldByNode[i] = makeNodeLocalMatrix(nodes[i]);
    }
  }

  return worldByNode;
}

function appendFacesByGltfMode(obj, indices, mode, vertexOffset, vertexCount) {
  const drawMode = mode === undefined ? 4 : mode;
  if (drawMode === 4) {
    appendFaces(obj, indices, Cesium.PrimitiveType.TRIANGLES, vertexOffset, vertexCount);
    return;
  }

  if (drawMode === 5) {
    appendFaces(obj, indices, Cesium.PrimitiveType.TRIANGLE_STRIP, vertexOffset, vertexCount);
    return;
  }

  // TRIANGLE_FAN
  if (drawMode === 6) {
    const src = indices || Array.from({ length: vertexCount }, (_v, i) => i);
    if (src.length < 3) return;
    const first = src[0];
    for (let i = 1; i + 1 < src.length; i++) {
      const a = first + 1 + vertexOffset;
      const b = src[i] + 1 + vertexOffset;
      const c = src[i + 1] + 1 + vertexOffset;
      obj.push(`f ${a} ${b} ${c}`);
    }
  }
}

function buildTriangleTriplets(indices, mode, vertexCount) {
  const drawMode = mode === undefined ? 4 : mode;
  const src = indices || Array.from({ length: vertexCount }, (_v, i) => i);
  const out = [];

  if (!src || src.length < 3) return out;

  // TRIANGLES
  if (drawMode === 4) {
    for (let i = 0; i + 2 < src.length; i += 3) {
      const a = src[i + 0];
      const b = src[i + 1];
      const c = src[i + 2];
      if (a !== b && b !== c && c !== a) out.push([a, b, c]);
    }
    return out;
  }

  // TRIANGLE_STRIP
  if (drawMode === 5) {
    for (let i = 0; i + 2 < src.length; i++) {
      const i0 = src[i + 0];
      const i1 = src[i + 1];
      const i2 = src[i + 2];
      if (i0 === i1 || i1 === i2 || i2 === i0) continue;
      if (i % 2 === 0) out.push([i0, i1, i2]);
      else out.push([i1, i0, i2]);
    }
    return out;
  }

  // TRIANGLE_FAN
  if (drawMode === 6) {
    const first = src[0];
    for (let i = 1; i + 1 < src.length; i++) {
      const b = src[i];
      const c = src[i + 1];
      if (first !== b && b !== c && c !== first) out.push([first, b, c]);
    }
    return out;
  }

  return out;
}

function toGltfModeFromCesiumPrimitive(primitiveType) {
  if (primitiveType === Cesium.PrimitiveType.TRIANGLE_STRIP) return 5;
  if (primitiveType === Cesium.PrimitiveType.TRIANGLE_FAN) return 6;
  return 4;
}

function getSceneWindowBounds(scene) {
  const w = scene?.canvas?.clientWidth || scene?.canvas?.width || 0;
  const h = scene?.canvas?.clientHeight || scene?.canvas?.height || 0;
  return {
    minX: 0,
    minY: 0,
    maxX: w,
    maxY: h,
    width: w,
    height: h
  };
}

function isPointInWindow(win, bounds) {
  if (!win || !bounds) return false;
  if (!Number.isFinite(win.x) || !Number.isFinite(win.y)) return false;
  return win.x >= bounds.minX && win.x <= bounds.maxX && win.y >= bounds.minY && win.y <= bounds.maxY;
}

function projectWorldToWindow(scene, worldPoint) {
  if (!scene || !worldPoint) return null;

  try {
    if (Cesium?.SceneTransforms?.worldToWindowCoordinates) {
      const p = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        worldPoint,
        new Cesium.Cartesian2()
      );
      if (p) return p;
    }
  } catch (_ignored) {}

  try {
    if (Cesium?.SceneTransforms?.wgs84ToWindowCoordinates) {
      const p = Cesium.SceneTransforms.wgs84ToWindowCoordinates(
        scene,
        worldPoint,
        new Cesium.Cartesian2()
      );
      if (p) return p;
    }
  } catch (_ignored) {}

  try {
    if (typeof scene.cartesianToCanvasCoordinates === "function") {
      const p = scene.cartesianToCanvasCoordinates(worldPoint, new Cesium.Cartesian2());
      if (p) return p;
    }
  } catch (_ignored) {}

  return null;
}

function triangleTouchesWindow(scene, bounds, p0, p1, p2) {
  const w0 = projectWorldToWindow(scene, p0);
  const w1 = projectWorldToWindow(scene, p1);
  const w2 = projectWorldToWindow(scene, p2);

  // If all fail projection, triangle is certainly outside/behind.
  if (!w0 && !w1 && !w2) return false;

  // Strict viewport clip: keep only if at least one vertex is inside.
  if (isPointInWindow(w0, bounds) || isPointInWindow(w1, bounds) || isPointInWindow(w2, bounds)) {
    return true;
  }

  // Optional centroid check to keep triangles crossing the border with no vertex inside.
  const projected = [w0, w1, w2].filter(Boolean);
  if (!projected.length) return false;
  let cx = 0;
  let cy = 0;
  for (const p of projected) {
    cx += p.x;
    cy += p.y;
  }
  cx /= projected.length;
  cy /= projected.length;
  return isPointInWindow(new Cesium.Cartesian2(cx, cy), bounds);
}

function triangleCentroidWorld(p0, p1, p2) {
  return new Cesium.Cartesian3(
    (p0.x + p1.x + p2.x) / 3,
    (p0.y + p1.y + p2.y) / 3,
    (p0.z + p1.z + p2.z) / 3
  );
}

function getDepthPickAtWindow(scene, win, visibilityState) {
  if (!scene || !win || !visibilityState) return null;
  if (!scene.pickPositionSupported) return null;

  const cellSize = visibilityState.cellSize || 3;
  const ix = Math.floor(win.x / cellSize);
  const iy = Math.floor(win.y / cellSize);
  const key = `${ix}:${iy}`;

  if (visibilityState.depthCache.has(key)) {
    return visibilityState.depthCache.get(key);
  }

  let picked = null;
  try {
    picked = scene.pickPosition(win);
  } catch (_ignored) {
    picked = null;
  }

  visibilityState.depthCache.set(key, picked || null);
  return picked;
}

function triangleVisibleInCurrentView(scene, bounds, p0, p1, p2, visibilityState) {
  if (!triangleTouchesWindow(scene, bounds, p0, p1, p2)) return false;

  if (!visibilityState?.useDepthTest) {
    return true;
  }

  const centerWorld = triangleCentroidWorld(p0, p1, p2);
  const centerWin = projectWorldToWindow(scene, centerWorld);
  if (!isPointInWindow(centerWin, bounds)) {
    return false;
  }

  const pickedWorld = getDepthPickAtWindow(scene, centerWin, visibilityState);
  if (!pickedWorld) {
    // No depth info at that pixel. Keep triangle if it is at least in the viewport.
    return true;
  }

  const camPos = scene?.camera?.positionWC;
  if (!camPos) return true;

  const dTri = Cesium.Cartesian3.distance(camPos, centerWorld);
  const dPick = Cesium.Cartesian3.distance(camPos, pickedWorld);
  const tolerance = Math.max(2.0, dPick * 0.01);

  // Triangle is visible if its centroid depth is close to front-most depth.
  return dTri <= dPick + tolerance;
}

function appendFilteredMeshToObj(obj, meshName, worldPositions, triangles, scene, bounds, vertexOffset, visibilityState, exportPositions = worldPositions) {
  if (!worldPositions || worldPositions.length < 3 || !triangles || !triangles.length) {
    return { vertexOffset, keptTriangles: 0, keptVertices: 0 };
  }

  const usedMap = new Map();
  const keptFaces = [];

  function ensureMapped(oldIndex) {
    if (usedMap.has(oldIndex)) return usedMap.get(oldIndex);
    const newIndex = usedMap.size;
    usedMap.set(oldIndex, newIndex);
    return newIndex;
  }

  for (const tri of triangles) {
    const i0 = tri[0];
    const i1 = tri[1];
    const i2 = tri[2];

    const p0 = worldPositions[i0];
    const p1 = worldPositions[i1];
    const p2 = worldPositions[i2];
    if (!p0 || !p1 || !p2) continue;

    if (!triangleVisibleInCurrentView(scene, bounds, p0, p1, p2, visibilityState)) continue;

    const n0 = ensureMapped(i0);
    const n1 = ensureMapped(i1);
    const n2 = ensureMapped(i2);
    keptFaces.push([n0, n1, n2]);
  }

  if (!keptFaces.length || !usedMap.size) {
    return { vertexOffset, keptTriangles: 0, keptVertices: 0 };
  }

  obj.push(`o ${meshName}`);

  const orderedOldIndices = Array.from(usedMap.entries())
    .sort((a, b) => a[1] - b[1])
    .map((entry) => entry[0]);

  for (const oldIndex of orderedOldIndices) {
    const p = exportPositions[oldIndex] || worldPositions[oldIndex];
    obj.push(`v ${p.x} ${p.y} ${p.z}`);
  }

  for (const face of keptFaces) {
    const a = face[0] + 1 + vertexOffset;
    const b = face[1] + 1 + vertexOffset;
    const c = face[2] + 1 + vertexOffset;
    obj.push(`f ${a} ${b} ${c}`);
  }

  return {
    vertexOffset: vertexOffset + orderedOldIndices.length,
    keptTriangles: keptFaces.length,
    keptVertices: orderedOldIndices.length
  };
}

function appendMeshToObj(obj, meshName, worldPositions, triangles, vertexOffset) {
  if (!worldPositions || worldPositions.length < 3 || !triangles || !triangles.length) {
    return { vertexOffset, keptTriangles: 0, keptVertices: 0 };
  }

  obj.push(`o ${meshName}`);

  for (const p of worldPositions) {
    obj.push(`v ${p.x} ${p.y} ${p.z}`);
  }

  for (const tri of triangles) {
    const a = tri[0] + 1 + vertexOffset;
    const b = tri[1] + 1 + vertexOffset;
    const c = tri[2] + 1 + vertexOffset;
    obj.push(`f ${a} ${b} ${c}`);
  }

  return {
    vertexOffset: vertexOffset + worldPositions.length,
    keptTriangles: triangles.length,
    keptVertices: worldPositions.length
  };
}

function getPrimitiveFeatureIdAccessorIndex(primitive) {
  const attributes = primitive?.attributes || {};

  if (attributes._BATCHID !== undefined && attributes._BATCHID !== null) {
    return attributes._BATCHID;
  }

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    const upper = String(key).toUpperCase();
    if (upper === "BATCHID" || upper === "_BATCHID" || upper.startsWith("FEATURE_ID")) {
      return value;
    }
  }

  const extFeatureIds = primitive?.extensions?.EXT_mesh_features?.featureIds;
  if (Array.isArray(extFeatureIds) && extFeatureIds.length > 0) {
    const first = extFeatureIds[0];
    if (first?.attribute !== undefined && first?.attribute !== null) {
      const attributeName = `_FEATURE_ID_${first.attribute}`;
      if (attributes[attributeName] !== undefined && attributes[attributeName] !== null) {
        return attributes[attributeName];
      }
    }

    if (first?.featureIds !== undefined && first?.featureIds !== null) {
      return first.featureIds;
    }
  }

  return null;
}

function readFeatureIdsForPrimitive(gltf, binChunk, primitive, vertexCount) {
  const accessorIndex = getPrimitiveFeatureIdAccessorIndex(primitive);
  if (accessorIndex === undefined || accessorIndex === null) return null;

  const featureData = readAccessorValues(gltf, binChunk, accessorIndex);
  if (!featureData || featureData.numComponents !== 1 || featureData.count < vertexCount) {
    return null;
  }

  const ids = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    ids[i] = Math.trunc(featureData.values[i]);
  }
  return ids;
}

function groupTrianglesByFeatureId(triangles, featureIds) {
  if (!triangles || !triangles.length) return [];
  if (!featureIds || !featureIds.length) {
    return [{ featureId: null, triangles }];
  }

  const groups = new Map();

  function dominantFeatureId(i0, i1, i2) {
    const a = featureIds[i0];
    const b = featureIds[i1];
    const c = featureIds[i2];
    if (a === b || a === c) return a;
    if (b === c) return b;
    return a;
  }

  for (const tri of triangles) {
    const featureId = dominantFeatureId(tri[0], tri[1], tri[2]);
    if (!groups.has(featureId)) {
      groups.set(featureId, []);
    }
    groups.get(featureId).push(tri);
  }

  return Array.from(groups.entries()).map(([featureId, groupedTriangles]) => ({
    featureId,
    triangles: groupedTriangles
  }));
}

function appendIndexedMeshSubsetToObj(obj, meshName, worldPositions, triangles, vertexOffset, exportPositions = worldPositions) {
  if (!worldPositions || !worldPositions.length || !triangles || !triangles.length) {
    return { vertexOffset, keptTriangles: 0, keptVertices: 0 };
  }

  const remap = new Map();
  const orderedIndices = [];

  function getNewIndex(oldIndex) {
    if (remap.has(oldIndex)) return remap.get(oldIndex);
    const newIndex = orderedIndices.length;
    remap.set(oldIndex, newIndex);
    orderedIndices.push(oldIndex);
    return newIndex;
  }

  const remappedTriangles = [];
  for (const tri of triangles) {
    remappedTriangles.push([
      getNewIndex(tri[0]),
      getNewIndex(tri[1]),
      getNewIndex(tri[2])
    ]);
  }

  obj.push(`o ${meshName}`);

  for (const oldIndex of orderedIndices) {
    const p = exportPositions[oldIndex] || worldPositions[oldIndex];
    obj.push(`v ${p.x} ${p.y} ${p.z}`);
  }

  for (const tri of remappedTriangles) {
    obj.push(`f ${tri[0] + 1 + vertexOffset} ${tri[1] + 1 + vertexOffset} ${tri[2] + 1 + vertexOffset}`);
  }

  return {
    vertexOffset: vertexOffset + orderedIndices.length,
    keptTriangles: remappedTriangles.length,
    keptVertices: orderedIndices.length
  };
}

function getCenterGroundCartesian(viewer) {
  const scene = viewer?.scene;
  const canvas = scene?.canvas;
  if (!scene || !canvas) return null;

  const center = new Cesium.Cartesian2(
    canvas.clientWidth / 2,
    canvas.clientHeight / 2
  );

  const ray = viewer.camera.getPickRay(center);
  if (!ray) return null;

  const globeHit = scene.globe?.pick(ray, scene);
  if (globeHit) return globeHit;

  return null;
}

function getCameraGroundCartesian(viewer) {
  const cameraCartographic = viewer?.camera?.positionCartographic;
  if (
    cameraCartographic &&
    Number.isFinite(cameraCartographic.longitude) &&
    Number.isFinite(cameraCartographic.latitude)
  ) {
    return Cesium.Cartesian3.fromRadians(
      cameraCartographic.longitude,
      cameraCartographic.latitude,
      0
    );
  }

  const cameraWorld = viewer?.camera?.positionWC;
  if (cameraWorld) {
    const cartographic = Cesium.Cartographic.fromCartesian(cameraWorld);
    if (
      cartographic &&
      Number.isFinite(cartographic.longitude) &&
      Number.isFinite(cartographic.latitude)
    ) {
      return Cesium.Cartesian3.fromRadians(
        cartographic.longitude,
        cartographic.latitude,
        0
      );
    }
  }

  return null;
}

function getExportOriginCartesian(viewer) {
  const centerGround = getCenterGroundCartesian(viewer);
  if (centerGround) return centerGround;

  const cameraGround = getCameraGroundCartesian(viewer);
  if (cameraGround) return cameraGround;

  const cameraCartographic = viewer?.camera?.positionCartographic;
  if (cameraCartographic) {
    return Cesium.Cartesian3.fromRadians(
      cameraCartographic.longitude,
      cameraCartographic.latitude,
      0
    );
  }

  return viewer?.camera?.positionWC || null;
}

function getExportOriginSource(viewer, exportOrigin) {
  if (!viewer || !exportOrigin) return null;

  const centerGround = getCenterGroundCartesian(viewer);
  if (centerGround && Cesium.Cartesian3.distance(centerGround, exportOrigin) < 0.01) {
    return "camera.getPickRay + scene.globe.pick";
  }

  const cameraGround = getCameraGroundCartesian(viewer);
  if (cameraGround && Cesium.Cartesian3.distance(cameraGround, exportOrigin) < 0.01) {
    return "camera.positionCartographic";
  }

  if (viewer?.camera?.positionCartographic) {
    return "camera.positionCartographic-fallback";
  }

  if (viewer?.camera?.positionWC) {
    return "camera.positionWC";
  }

  return "unknown";
}

function createEnuLocalFrame(originCartesian) {
  if (!originCartesian) return null;

  const originCartographic = Cesium.Cartographic.fromCartesian(originCartesian);
  if (!originCartographic) return null;

  const longitude = originCartographic.longitude;
  const latitude = originCartographic.latitude;
  const sinLon = Math.sin(longitude);
  const cosLon = Math.cos(longitude);
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);

  const fixedFrame = Cesium.Transforms.eastNorthUpToFixedFrame(
    originCartesian,
    Cesium.Ellipsoid.WGS84,
    new Cesium.Matrix4()
  );
  const localFrame = Cesium.Matrix4.inverseTransformation(fixedFrame, new Cesium.Matrix4());

  return {
    originCartesian,
    originCartographic,
    longitude,
    latitude,
    sinLon,
    cosLon,
    sinLat,
    cosLat,
    fixedFrame,
    localFrame,
    frameType: "surface-enu"
  };
}

function projectToEarthSurface(cartesian) {
  if (!cartesian) return null;
  const c = Cesium.Cartographic.fromCartesian(cartesian);
  if (!c) return null;
  return Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, 0);
}

function transformWorldToLocal(localFrame, worldPoint, result) {
  if (!worldPoint) return null;
  const out = result || new Cesium.Cartesian3();

  if (localFrame?.frameType === "surface-enu" && localFrame.originCartesian) {
    const dx = worldPoint.x - localFrame.originCartesian.x;
    const dy = worldPoint.y - localFrame.originCartesian.y;
    const dz = worldPoint.z - localFrame.originCartesian.z;

    out.x = -localFrame.sinLon * dx + localFrame.cosLon * dy;
    out.y =
      -localFrame.sinLat * localFrame.cosLon * dx -
      localFrame.sinLat * localFrame.sinLon * dy +
      localFrame.cosLat * dz;
    out.z =
      localFrame.cosLat * localFrame.cosLon * dx +
      localFrame.cosLat * localFrame.sinLon * dy +
      localFrame.sinLat * dz;

    return out;
  }

  if (!localFrame?.localFrame) {
    return Cesium.Cartesian3.clone(worldPoint, out);
  }

  return Cesium.Matrix4.multiplyByPoint(
    localFrame.localFrame,
    worldPoint,
    out
  );
}

function transformPositionsToLocal(worldPositions, localFrame) {
  if (!worldPositions?.length) return [];
  if (!localFrame?.localFrame) return worldPositions;

  return worldPositions.map((worldPoint) =>
    transformWorldToLocal(localFrame, worldPoint, new Cesium.Cartesian3())
  );
}

function createExportLocalFrame(viewer, originCartesian) {
  const surfaceOrigin = projectToEarthSurface(originCartesian);
  if (!surfaceOrigin) return null;
  return createEnuLocalFrame(surfaceOrigin);
}

async function exportVisibleObjFromB3dmTiles(visibleTiles, tileset, scene, exportLocalFrame, onProgress = null) {
  const obj = ["# Cesium OBJ export (b3dm fallback)", ""];
  const debug = [];
  const yielder = createChunkedYieldController({
    timeBudgetMs: 12,
    maxOpsBeforeYield: 24
  });

  let vertexOffset = 0;
  let meshCount = 0;
  const collectedMeshes = [];
  const axisCorrectionMatrix = getTilesetAxisCorrectionMatrix(tileset);
  const totalTiles = Math.max(1, visibleTiles.length);

  if (typeof onProgress === "function") {
    onProgress(0);
  }

  let parsedTileCount = 0;
  for (const tile of visibleTiles) {
    await yielder.maybeYield();

    const tileUrl = getTileContentUrl(tile, tileset);
    const tileMatrix = Cesium.Matrix4.clone(
      tile?.computedTransform || tile?.transform || Cesium.Matrix4.IDENTITY,
      new Cesium.Matrix4()
    );

    const tileReport = {
      url: tileUrl,
      loaded: false,
      parsed: false,
      meshes: 0,
      featureSplitMeshes: 0,
      error: null
    };

    if (!tileUrl) {
      tileReport.error = "No tile URL";
      debug.push(tileReport);
      continue;
    }

    try {
      const rawBuffer = await fetchArrayBufferWithCesium(tileUrl);
      tileReport.loaded = !!rawBuffer;
      if (!rawBuffer) {
        tileReport.error = "No arrayBuffer";
        debug.push(tileReport);
        continue;
      }

      const parsedTile = parseB3dmOrGlb(rawBuffer);
      if (!parsedTile.glbBuffer) {
        tileReport.error = "Could not parse b3dm/glb";
        debug.push(tileReport);
        continue;
      }

      const { gltf, binChunk } = parseGlb(parsedTile.glbBuffer);
      if (!gltf || !binChunk) {
        tileReport.error = "Invalid GLB chunks";
        debug.push(tileReport);
        continue;
      }

      tileReport.parsed = true;

      const contentTransform = getContentTransform(parsedTile.rtcCenter, gltf);
      const tileContentMatrix = Cesium.Matrix4.multiplyTransformation(
        tileMatrix,
        contentTransform,
        new Cesium.Matrix4()
      );
      const tileRuntimeMatrix = Cesium.Matrix4.multiplyTransformation(
        tileContentMatrix,
        axisCorrectionMatrix,
        new Cesium.Matrix4()
      );

      const nodeWorlds = buildNodeWorldMatrices(gltf);
      const nodes = gltf.nodes || [];
      const meshes = gltf.meshes || [];

      for (let n = 0; n < nodes.length; n++) {
        await yielder.maybeYield();

        const node = nodes[n];
        if (!node || node.mesh === undefined || node.mesh === null) continue;

        const mesh = meshes[node.mesh];
        if (!mesh || !Array.isArray(mesh.primitives)) continue;

        const nodeWorld = nodeWorlds[n] || Cesium.Matrix4.IDENTITY;
        const finalMatrix = Cesium.Matrix4.multiplyTransformation(
          tileRuntimeMatrix,
          nodeWorld,
          new Cesium.Matrix4()
        );

        for (const primitive of mesh.primitives) {
          await yielder.maybeYield();

          const posAccessorIndex = primitive?.attributes?.POSITION;
          if (posAccessorIndex === undefined || posAccessorIndex === null) continue;

          const posData = readAccessorValues(gltf, binChunk, posAccessorIndex);
          if (!posData || posData.numComponents < 3 || posData.count < 3) continue;

          const vertexCount = posData.count;
          const featureIds = readFeatureIdsForPrimitive(gltf, binChunk, primitive, vertexCount);
          let indices = null;

          if (primitive.indices !== undefined && primitive.indices !== null) {
            const idxData = readAccessorValues(gltf, binChunk, primitive.indices);
            if (idxData && idxData.numComponents === 1) {
              indices = new Uint32Array(idxData.count);
              for (let i = 0; i < idxData.count; i++) {
                indices[i] = Math.max(0, Math.trunc(idxData.values[i]));

                if ((i & 2047) === 0) {
                  await yielder.maybeYield();
                }
              }
            }
          }

          const worldPositions = new Array(vertexCount);
          for (let i = 0; i < vertexCount; i++) {
            const local = new Cesium.Cartesian3(
              posData.values[i * posData.numComponents + 0],
              posData.values[i * posData.numComponents + 1],
              posData.values[i * posData.numComponents + 2]
            );
            worldPositions[i] = Cesium.Matrix4.multiplyByPoint(finalMatrix, local, new Cesium.Cartesian3());

            if ((i & 1023) === 0) {
              await yielder.maybeYield();
            }
          }

          const triangles = buildTriangleTriplets(indices, primitive.mode, vertexCount);
          if (!triangles.length) continue;

          const featureGroups = groupTrianglesByFeatureId(triangles, featureIds);

          for (const featureGroup of featureGroups) {
            collectedMeshes.push({
              tileReport,
              meshName:
                featureGroup.featureId === null
                  ? `tile_${collectedMeshes.length}`
                  : `tile_${collectedMeshes.length}_feature_${featureGroup.featureId}`,
              worldPositions,
              triangles: featureGroup.triangles,
              featureId: featureGroup.featureId
            });

            await yielder.maybeYield();
          }
        }
      }
    } catch (err) {
      tileReport.error = String(err?.message || err || "Unknown error");
    }

    debug.push(tileReport);
    parsedTileCount++;

    if (typeof onProgress === "function") {
      const parseRatio = (parsedTileCount / totalTiles) * 0.72;
      onProgress(parseRatio);
    }
  }

  // Second pass: write every parsed mesh to OBJ.
  const totalMeshes = Math.max(1, collectedMeshes.length);
  let writtenMeshes = 0;
  for (const mesh of collectedMeshes) {
    await yielder.maybeYield();

    const exportPositions = exportLocalFrame?.localFrame
      ? transformPositionsToLocal(mesh.worldPositions, exportLocalFrame)
      : mesh.worldPositions;

    const appendResult = appendIndexedMeshSubsetToObj(
      obj,
      mesh.meshName,
      mesh.worldPositions,
      mesh.triangles,
      vertexOffset,
      exportPositions
    );

    if (appendResult.keptTriangles <= 0) continue;

    vertexOffset = appendResult.vertexOffset;
    meshCount++;
    mesh.tileReport.meshes++;
    if (mesh.featureId !== null && mesh.featureId !== undefined) {
      mesh.tileReport.featureSplitMeshes++;
    }

    writtenMeshes++;
    if (typeof onProgress === "function") {
      const writeRatio = 0.72 + (writtenMeshes / totalMeshes) * 0.28;
      onProgress(writeRatio);
    }
  }

  await yielder.maybeYield(true);

  if (typeof onProgress === "function") {
    onProgress(1);
  }

  return {
    obj,
    meshCount,
    debug,
    parsedMeshCount: collectedMeshes.length
  };
}

function buildDebugReport() {
  const viewer = window.cesiumViewer;
  const tiles = Array.from(visibleTilesMap.values());

  const report = {
    timestamp: new Date().toISOString(),
    hasViewer: !!viewer,
    visibleTileCount: tiles.length,
    tiles: []
  };

  for (const tile of tiles) {
    const content = tile?.content;
    const model = content?._model;
    const drawCommands = getDrawCommandsFromModel(model);

    report.tiles.push({
      url: content?.url || tile?._header?.content?.uri || null,
      featuresLength: content?.featuresLength || 0,
      trianglesLength: content?.trianglesLength || 0,
      hasModel: !!model,
      modelKeys: model ? Object.keys(model).slice(0, 60) : [],
      drawCommandCount: drawCommands.length
    });
  }

  return report;
}

function exportVisibleObj(options = {}) {
  const {
    downloadObj = true,
    downloadJson = false
  } = options;

  const viewer = window.cesiumViewer;
  const tileset = window.osmBuildingsTileset;

  if (!viewer || !tileset) {
    alert("Start the viewer first.");
    return;
  }

  if (!installVisibleTileTracking()) {
    alert("Could not install visible tile tracking.");
    return;
  }

  setExportProgress(1);

  viewer.scene.requestRender();

  setTimeout(async () => {
    try {
      const visibleTiles = Array.from(visibleTilesMap.values());
      const scene = viewer.scene;
      const gl = scene?.context?._gl || null;
      const bounds = getSceneWindowBounds(scene);
      const exportOriginRaw = getExportOriginCartesian(viewer);
      const exportOrigin = projectToEarthSurface(exportOriginRaw) || exportOriginRaw;
      const exportOriginSource = getExportOriginSource(viewer, exportOriginRaw);
      const exportLocalFrame = createExportLocalFrame(viewer, exportOrigin);
      const visibilityState = {
        useDepthTest: true,
        depthCache: new Map(),
        cellSize: 3
      };
      const yielder = createChunkedYieldController({
        timeBudgetMs: 12,
        maxOpsBeforeYield: 24
      });

      setExportProgress(5);

      if (visibleTiles.length === 0) {
        const debug = buildDebugReport();
        if (downloadJson) {
          downloadTextFile("export_debug.json", JSON.stringify(debug, null, 2));
        }

        if (downloadObj && downloadJson) {
          alert("No visible tiles were captured. I downloaded export_debug.json.");
        } else if (downloadObj) {
          alert("No visible tiles were captured.");
        } else {
          alert("JSON exported.");
        }

        completeExportProgress();
        return;
      }

    let obj = [];
    let vertexOffset = 0;
    let meshCount = 0;

    obj.push("# Cesium OBJ export");
    obj.push("");

    const debug = {
      timestamp: new Date().toISOString(),
      visibleTileCount: visibleTiles.length,
      extractedMeshes: 0,
      glAvailable: !!gl,
      depthTestEnabled: visibilityState.useDepthTest,
      originSource: exportOriginSource,
      localFrameType: exportLocalFrame?.frameType || null,
      originCartesian: exportOrigin ? {
        x: exportOrigin.x,
        y: exportOrigin.y,
        z: exportOrigin.z
      } : null,
      tiles: []
    };

      const tileFirst = await exportVisibleObjFromB3dmTiles(
        visibleTiles,
        tileset,
        scene,
        exportLocalFrame,
        (ratio) => {
          const clampedRatio = Math.max(0, Math.min(1, ratio));
          const mappedPercent = 10 + clampedRatio * 70;
          setExportProgress(mappedPercent);
        }
      );
      debug.tileFirst = {
        attempted: true,
        extractedMeshes: tileFirst.meshCount,
        parsedMeshes: tileFirst.parsedMeshCount,
        tiles: tileFirst.debug
      };
      if (downloadJson) {
        downloadTextFile("export_debug.json", JSON.stringify(debug, null, 2));
      }

      if (tileFirst.meshCount > 0) {
        if (downloadObj) {
          downloadTextFile("cesium_export.obj", tileFirst.obj.join("\n"));
        }

        if (downloadObj && downloadJson) {
          alert(`OBJ + JSON exported using tile parser. Meshes: ${tileFirst.meshCount}`);
        } else if (downloadObj) {
          alert(`OBJ exported using tile parser. Meshes: ${tileFirst.meshCount}`);
        } else {
          alert(`JSON exported using tile parser. Meshes found: ${tileFirst.meshCount}`);
        }

        completeExportProgress();
        return;
      }

      setExportProgress(80);

      const totalFallbackCommands = Math.max(
        1,
        visibleTiles.reduce((sum, tile) => {
          const content = tile?.content;
          const model = content?._model;
          const drawCommands = getDrawCommandsFromModel(model);
          return sum + (drawCommands.length || 0);
        }, 0)
      );
      let processedFallbackCommands = 0;

      for (const tile of visibleTiles) {
      await yielder.maybeYield();

      const content = tile?.content;
      const model = content?._model;
      const drawCommands = getDrawCommandsFromModel(model);

      const tileDebug = {
        url: content?.url || tile?._header?.content?.uri || null,
        featuresLength: content?.featuresLength || 0,
        trianglesLength: content?.trianglesLength || 0,
        hasModel: !!model,
        drawCommandCount: drawCommands.length,
        extractedFromCommands: 0,
        failedCommands: 0
      };

      if (!model || !drawCommands.length) {
        debug.tiles.push(tileDebug);
        continue;
      }

        for (let c = 0; c < drawCommands.length; c++) {
        await yielder.maybeYield();

          const cmd = drawCommands[c];
          const vao = getVertexArrayFromCommand(cmd);
          if (!vao) {
            tileDebug.failedCommands++;
            processedFallbackCommands++;
            if ((processedFallbackCommands & 7) === 0) {
              setExportProgress(80 + (processedFallbackCommands / totalFallbackCommands) * 19);
            }
            continue;
          }

          const attributes = getAttributesFromVertexArray(vao);
          const positionAttr = getPositionAttribute(attributes);
          if (!positionAttr) {
            tileDebug.failedCommands++;
            processedFallbackCommands++;
            if ((processedFallbackCommands & 7) === 0) {
              setExportProgress(80 + (processedFallbackCommands / totalFallbackCommands) * 19);
            }
            continue;
          }

          const positions = decodePositionsFromAttribute(positionAttr, vao, gl);
          if (!positions || positions.length < 9) {
            tileDebug.failedCommands++;
            processedFallbackCommands++;
            if ((processedFallbackCommands & 7) === 0) {
              setExportProgress(80 + (processedFallbackCommands / totalFallbackCommands) * 19);
            }
            continue;
          }

          const vertexCount = positions.length / 3;
          const indexBuffer = getIndexBufferFromVertexArray(vao);
          const indices = decodeIndices(indexBuffer, gl, vertexCount);

          const modelMatrix = cmd?.modelMatrix || model?.modelMatrix || Cesium.Matrix4.IDENTITY;

          const worldPositions = new Array(vertexCount);
          for (let i = 0; i < vertexCount; i++) {
            const p = new Cesium.Cartesian3(
              positions[i * 3 + 0],
              positions[i * 3 + 1],
              positions[i * 3 + 2]
            );

            worldPositions[i] = Cesium.Matrix4.multiplyByPoint(modelMatrix, p, new Cesium.Cartesian3());

            if ((i & 1023) === 0) {
              await yielder.maybeYield();
            }
          }

          const primitiveType = cmd?.primitiveType;
          const mode = toGltfModeFromCesiumPrimitive(primitiveType);
          const triangles = buildTriangleTriplets(indices, mode, vertexCount);
          const exportPositions = exportLocalFrame?.localFrame
            ? transformPositionsToLocal(worldPositions, exportLocalFrame)
            : worldPositions;
          const appendResult = appendFilteredMeshToObj(
            obj,
            `tile_${meshCount}`,
            worldPositions,
            triangles,
            scene,
            bounds,
            vertexOffset,
            visibilityState,
            exportPositions
          );

          if (appendResult.keptTriangles <= 0) {
            tileDebug.failedCommands++;
            processedFallbackCommands++;
            if ((processedFallbackCommands & 7) === 0) {
              setExportProgress(80 + (processedFallbackCommands / totalFallbackCommands) * 19);
            }
            continue;
          }

          vertexOffset = appendResult.vertexOffset;
          meshCount++;
          tileDebug.extractedFromCommands++;

          processedFallbackCommands++;
          if ((processedFallbackCommands & 7) === 0) {
            setExportProgress(80 + (processedFallbackCommands / totalFallbackCommands) * 19);
          }
        }

        debug.tiles.push(tileDebug);
      }

      await yielder.maybeYield(true);
      setExportProgress(99);

      debug.extractedMeshes = meshCount;
      if (downloadJson) {
        downloadTextFile("export_debug.json", JSON.stringify(debug, null, 2));
      }

      if (meshCount === 0) {
        if (downloadObj && downloadJson) {
          alert("No mesh data could be extracted from the tile parser or draw-command fallback. I downloaded export_debug.json.");
        } else if (downloadObj) {
          alert("No mesh data could be extracted from the tile parser or draw-command fallback.");
        } else {
          alert("JSON exported.");
        }

        completeExportProgress();
        return;
      }

      if (downloadObj) {
        downloadTextFile("cesium_export.obj", obj.join("\n"));
      }

      if (downloadObj && downloadJson) {
        alert(`OBJ + JSON exported using draw-command fallback. Meshes: ${meshCount}`);
      } else if (downloadObj) {
        alert(`OBJ exported using draw-command fallback. Meshes: ${meshCount}`);
      } else {
        alert(`JSON exported using draw-command fallback. Meshes found: ${meshCount}`);
      }

      completeExportProgress();
    } catch (error) {
      console.error("Export failed:", error);
      failExportProgress();
      alert(`Export failed: ${error?.message || error}`);
    }
  }, 700);
}

function exportVisibleJson() {
  exportVisibleObj({ downloadObj: false, downloadJson: true });
}

const exportBtn = document.getElementById("exportObjBtn");
if (exportBtn) {
  exportBtn.addEventListener("click", () => exportVisibleObj({ downloadObj: true, downloadJson: false }));
}

const exportJsonBtn = document.getElementById("exportJsonBtn");
if (exportJsonBtn) {
  exportJsonBtn.addEventListener("click", exportVisibleJson);
}