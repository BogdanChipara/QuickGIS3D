let welcomeImageUrls = [];
let welcomeImageIndex = 0;
let welcomeRotateTimerId = null;
let welcomeActiveLayerId = "welcomeBgA";
let welcomeSwapInProgress = false;
const WELCOME_SWAP_MS = 2000;

function getWelcomeBgLayers() {

  const layerA = document.getElementById("welcomeBgA");
  const layerB = document.getElementById("welcomeBgB");

  if (!layerA || !layerB) {
    return null;
  }

  return {
    welcomeBgA: layerA,
    welcomeBgB: layerB
  };

}

function normalizeWelcomeImageHref(href) {

  const clean = href.split("#")[0].split("?")[0].trim();
  if (!clean) return null;

  if (/^https?:\/\//i.test(clean)) {
    return clean;
  }

  if (/^\/welcomeimages\//i.test(clean)) {
    return clean;
  }

  if (/^welcomeimages\//i.test(clean)) {
    return clean;
  }

  return `welcomeimages/${clean.replace(/^\.\/?/, "")}`;

}

async function discoverWelcomeImages() {

  try {
    const response = await fetch("welcomeimages/");
    if (!response.ok) {
      return [];
    }

    const html = await response.text();
    const regex = /href=["']([^"']+\.(?:jpg|jpeg|png|webp|gif))["']/ig;
    const found = [];
    let match = null;

    while ((match = regex.exec(html)) !== null) {
      const normalized = normalizeWelcomeImageHref(match[1]);
      if (normalized) {
        found.push(normalized);
      }
    }

    return [...new Set(found)];
  } catch (error) {
    return [];
  }

}

function preloadImage(url) {

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (typeof image.decode === "function") {
        image.decode().then(() => resolve()).catch(() => resolve());
        return;
      }
      resolve();
    };
    image.onerror = () => reject(new Error(`Could not load image: ${url}`));
    image.src = url;
  });

}

async function swapWelcomeBackgroundTo(url) {

  const layers = getWelcomeBgLayers();
  if (!layers) return;

  const nextLayerId = welcomeActiveLayerId === "welcomeBgA" ? "welcomeBgB" : "welcomeBgA";
  const currentLayer = layers[welcomeActiveLayerId];
  const nextLayer = layers[nextLayerId];

  await preloadImage(url);
  nextLayer.style.backgroundImage = `url("${url}")`;

  nextLayer.classList.add("is-visible");
  currentLayer.classList.remove("is-visible");
  welcomeActiveLayerId = nextLayerId;

}

async function rotateWelcomeBackgroundOnce() {

  if (!welcomeImageUrls.length || welcomeSwapInProgress) {
    return;
  }

  welcomeSwapInProgress = true;
  welcomeImageIndex = (welcomeImageIndex + 1) % welcomeImageUrls.length;

  try {
    await swapWelcomeBackgroundTo(welcomeImageUrls[welcomeImageIndex]);
  } catch (error) {
    // Keep the current image if the next one fails to load.
  } finally {
    welcomeSwapInProgress = false;
  }

}

async function initWelcomeBackgroundRotator() {

  welcomeImageUrls = await discoverWelcomeImages();
  if (!welcomeImageUrls.length) {
    return;
  }

  welcomeImageIndex = 0;
  try {
    await swapWelcomeBackgroundTo(welcomeImageUrls[welcomeImageIndex]);
  } catch (error) {
    return;
  }

  if (welcomeRotateTimerId) {
    clearInterval(welcomeRotateTimerId);
  }

  welcomeRotateTimerId = window.setInterval(() => {
    rotateWelcomeBackgroundOnce();
  }, WELCOME_SWAP_MS);

}

initWelcomeBackgroundRotator();
