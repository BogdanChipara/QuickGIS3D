let welcomeImageUrls = [];
let welcomeImageIndex = 0;
let welcomeRotateTimerId = null;
let welcomeActiveLayerId = "welcomeBgA";
let welcomeSwapInProgress = false;
const WELCOME_SWAP_MS = 2000;
const WELCOME_IMAGE_FILENAMES = [
  "Amsterdam.jpg",
  "Berlin.jpg",
  "Dubai.jpg",
  "London.jpg",
  "NewYork.jpg",
  "Oslo.jpg",
  "SaoPaulo.jpg",
  "Shanghai.jpg",
  "Sidney.jpg",
  "Singapore.jpg",
  "Tirana.jpg",
  "Venice.jpg"
];

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

function discoverWelcomeImages() {

  return WELCOME_IMAGE_FILENAMES.map((filename) =>
    new URL(`welcomeimages/${encodeURIComponent(filename)}`, window.location.href).toString()
  );

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

  welcomeImageUrls = discoverWelcomeImages();
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
