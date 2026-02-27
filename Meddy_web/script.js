const revealItems = [...document.querySelectorAll(".reveal")];
const stepCards = [...document.querySelectorAll(".step-card")];
const screenshots = [...document.querySelectorAll(".shot")];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (!reduceMotion) {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    {
      root: null,
      threshold: 0.18,
      rootMargin: "0px 0px -6% 0px",
    }
  );

  revealItems.forEach((item) => revealObserver.observe(item));
} else {
  revealItems.forEach((item) => item.classList.add("is-visible"));
}

const setActiveStep = (activeCard) => {
  stepCards.forEach((card) => card.classList.remove("step-active"));
  if (activeCard) {
    activeCard.classList.add("step-active");
  }
};

const stepObserver = new IntersectionObserver(
  (entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio);

    if (visible.length > 0) {
      setActiveStep(visible[0].target);
    }
  },
  {
    root: null,
    threshold: [0.2, 0.45, 0.7],
    rootMargin: "-15% 0px -32% 0px",
  }
);

stepCards.forEach((card) => stepObserver.observe(card));

if (!reduceMotion) {
  let ticking = false;

  const renderParallax = () => {
    const viewportCenter = window.innerHeight / 2;

    screenshots.forEach((image) => {
      const bounds = image.getBoundingClientRect();
      const imageCenter = bounds.top + bounds.height / 2;
      const offset = (viewportCenter - imageCenter) * 0.018;
      const translateY = Math.max(-10, Math.min(10, offset));
      image.style.setProperty("--parallax", `${translateY.toFixed(2)}px`);
    });

    ticking = false;
  };

  const requestRender = () => {
    if (ticking) {
      return;
    }
    ticking = true;
    window.requestAnimationFrame(renderParallax);
  };

  window.addEventListener("scroll", requestRender, { passive: true });
  window.addEventListener("resize", requestRender);
  requestRender();
}
