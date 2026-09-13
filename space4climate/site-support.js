(function () {
  var doc = document.documentElement;
  if (doc) {
    doc.classList.add("s4c-js");
    doc.setAttribute("data-js", "enabled");
  }

  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
    requestAnimationFrame(function () {
      history.scrollRestoration = "auto";
    });
  }

  function assetPrefix() {
    var script = document.currentScript;
    var src = (script && script.src) || "/site-support.js";
    return src.replace(/site-support\.js(\?.*)?$/, "");
  }

  function ensurePerfStyles() {
    if (document.querySelector('link[href*="perf.css"]')) return;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = assetPrefix() + "perf.css?v=7";
    document.head.appendChild(link);
  }

  function NoopSplit() {
    return { revert: function () {}, chars: [], words: [], lines: [] };
  }
  NoopSplit._s4c = true;

  function lockSplitText() {
    try {
      Object.defineProperty(window, "SplitText", {
        configurable: true,
        get: function () {
          return NoopSplit;
        },
        set: function () {}
      });
    } catch (err) {
      window.SplitText = NoopSplit;
    }
  }

  function disarmScrollAnimations() {
    try {
      lockSplitText();

      if (window.gsap && typeof window.gsap.timeline === "function" && !window.gsap.timeline._s4c) {
        var origTimeline = window.gsap.timeline;
        window.gsap.timeline = function (vars) {
          if (vars && vars.scrollTrigger) {
            vars = Object.assign({}, vars);
            delete vars.scrollTrigger;
          }
          return origTimeline.apply(this, arguments);
        };
        window.gsap.timeline._s4c = true;
      }

      if (window.ScrollTrigger && !window.ScrollTrigger._s4c) {
        window.ScrollTrigger._s4c = true;
        if (typeof window.ScrollTrigger.config === "function") {
          window.ScrollTrigger.config({ autoRefreshEvents: "none" });
        }
        if (typeof window.ScrollTrigger.normalizeScroll === "function") {
          window.ScrollTrigger.normalizeScroll(false);
        }
        if (typeof window.ScrollTrigger.create === "function") {
          window.ScrollTrigger.create = function () {
            return { kill: function () {}, animation: null };
          };
        }
      }
    } catch (err) {}
  }

  function getMediaLabel(element, fallback) {
    var label = element.getAttribute("title") || element.getAttribute("aria-label");
    if (label) return label;

    var container = element.closest("section, article, div, figure");
    if (container) {
      var heading = container.querySelector("h1, h2, h3, h4, h5, h6");
      if (heading && heading.textContent.trim()) {
        return heading.textContent.trim();
      }
    }

    return fallback;
  }

  function enhanceEmbeds() {
    var embeds = document.querySelectorAll("iframe, video, audio");
    embeds.forEach(function (element, index) {
      element.setAttribute("data-js-enhanced", "true");

      if (element.tagName === "IFRAME") {
        var isHero = element.closest(".section-video-hero") || element.classList.contains("home");
        if (!isHero && !element.hasAttribute("loading")) {
          element.setAttribute("loading", "lazy");
        }
        if (!element.hasAttribute("referrerpolicy")) {
          element.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
        }
        if (!element.hasAttribute("allow")) {
          element.setAttribute("allow", "autoplay; fullscreen; picture-in-picture; encrypted-media");
        }
        element.setAttribute("allowfullscreen", "");
        if (!element.getAttribute("title")) {
          element.setAttribute("title", getMediaLabel(element, "Embedded media " + (index + 1)));
        }
      }

      if (element.tagName === "VIDEO" || element.tagName === "AUDIO") {
        if (!element.hasAttribute("preload")) {
          element.setAttribute("preload", "metadata");
        }
        if (!element.hasAttribute("controls")) {
          element.setAttribute("controls", "controls");
        }
        if (element.tagName === "VIDEO") {
          element.setAttribute("playsinline", "playsinline");
        }
        if (!element.getAttribute("aria-label") && !element.getAttribute("title")) {
          element.setAttribute("aria-label", getMediaLabel(element, "Media playback " + (index + 1)));
        }
      }
    });

    var heroIframe = document.querySelector(".section-video-hero iframe");
    if (heroIframe) {
      heroIframe.removeAttribute("loading");
    }
  }

  function flattenScrollHijack() {
    var selectors = [
      ".scroll-wrapper",
      ".second-section",
      ".scroll-track",
      ".horizontal-scroll-camera",
      ".horizontal-scroll-content",
      ".scroll-content-wrapper"
    ];
    document.querySelectorAll(selectors.join(",")).forEach(function (el) {
      el.style.setProperty("transform", "none", "important");
      el.style.setProperty("height", "auto", "important");
      el.style.setProperty("width", "100%", "important");
      el.style.setProperty("position", "relative", "important");
      el.style.setProperty("will-change", "auto", "important");
    });
  }

  function killScrollTriggers() {
    try {
      if (window.ScrollTrigger && typeof window.ScrollTrigger.getAll === "function") {
        window.ScrollTrigger.getAll().forEach(function (trigger) {
          trigger.kill(true);
        });
      }
      if (window.gsap) {
        document.querySelectorAll(".split-chars, .split-words, .split-lines").forEach(function (el) {
          window.gsap.set(el, { clearProps: "transform,opacity,rotationX" });
        });
      }
    } catch (err) {}
  }

  function stopIx2ScrollEngine() {
    if (!document.querySelector(".scroll-wrapper, .horizontal-scroll-camera, .second-section")) {
      flattenScrollHijack();
      return;
    }
    try {
      if (!window.Webflow || typeof window.Webflow.require !== "function") return;
      var ix2 = window.Webflow.require("ix2");
      if (ix2 && typeof ix2.destroy === "function") {
        ix2.destroy();
      }
    } catch (err) {}
    flattenScrollHijack();
  }

  function observeMedia(selector, onChange) {
    var nodes = document.querySelectorAll(selector);
    if (!nodes.length || !("IntersectionObserver" in window)) return;

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          onChange(entry.target, entry.isIntersecting);
        });
      },
      { rootMargin: "80px 0px", threshold: 0.12 }
    );

    nodes.forEach(function (node) {
      observer.observe(node);
    });
  }

  function tameVideos() {
    observeMedia('iframe[src*="vidzflow"], iframe[src*="youtube"], iframe[src*="vimeo"]', function (iframe, visible) {
      if (iframe.closest(".section-video-hero") || iframe.classList.contains("home")) return;
      var win = iframe.contentWindow;
      if (win) {
        try {
          win.postMessage(visible ? "playerPlay" : "playerPause", "*");
        } catch (err) {}
      }
      if (visible) {
        iframe.removeAttribute("data-s4c-paused");
      } else {
        iframe.setAttribute("data-s4c-paused", "true");
      }
    });

    observeMedia("video[autoplay], video[data-autoplay]", function (video, visible) {
      try {
        if (visible) {
          video.play().catch(function () {});
        } else {
          video.pause();
        }
      } catch (err) {}
    });
  }

  function lazyBelowFoldImages() {
    var images = document.querySelectorAll("img[loading='eager'], img:not([loading])");
    images.forEach(function (img, index) {
      if (index < 2) return;
      var rect = img.getBoundingClientRect();
      if (rect.top > window.innerHeight * 1.15) {
        img.setAttribute("loading", "lazy");
        img.setAttribute("decoding", "async");
      }
    });
  }

  function assetRoot() {
    var prefix = assetPrefix();
    if (prefix && prefix !== "/") return prefix;
    var path = (window.location && window.location.pathname) || "/";
    if (/\/(lab-notes|legal|news|projects|programs|case-studies)\//.test(path)) {
      return "../";
    }
    return "";
  }

  function makeLoginLink(className) {
    var link = document.createElement("a");
    link.href = assetRoot() + "login.html";
    link.className = className;
    link.innerHTML = '<div class="nav_btn_text">Log in</div>';
    return link;
  }

  function flattenProgramCards() {
    document.querySelectorAll(".slider-wrapper").forEach(function (wrap) {
      if (!wrap.querySelector(".card.programs")) return;
      wrap.querySelectorAll(".collection-list, .w-dyn-items, .w-dyn-item, .swiper, .swiper-wrapper, .swiper-slide").forEach(function (el) {
        el.style.setProperty("transform", "none", "important");
        el.style.setProperty("width", el.classList.contains("w-dyn-item") || el.classList.contains("swiper-slide") ? "auto" : "100%", "important");
      });
    });
    document.querySelectorAll("a.card.programs img, .card.programs img").forEach(function (img) {
      var src = img.getAttribute("src") || "";
      if (src.indexOf("S4C workshops") !== -1 || src.indexOf("S4C%20workshops") !== -1) {
        src = "https://cdn.prod.website-files.com/65cebd17c70b035a9f4dea65/69b9740bc12922254be8b963_MissionZeroTechnologies_Building-Materials.jpg";
        img.setAttribute("src", src);
      } else if (src.indexOf(" ") !== -1) {
        img.setAttribute("src", src.replace(/ /g, "%20"));
      }
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
    });
  }

  function enhanceDropdowns() {
    if (window.matchMedia && window.matchMedia("(max-width: 991px)").matches) return;
    document.querySelectorAll(".nav_dropdown_wrap").forEach(function (wrap) {
      if (wrap.getAttribute("data-s4c-dd") === "1") return;
      wrap.setAttribute("data-s4c-dd", "1");
      wrap.addEventListener("mouseenter", function () {
        document.querySelectorAll(".nav_dropdown_wrap").forEach(function (other) {
          if (other !== wrap) other.classList.remove("active");
        });
        wrap.classList.add("active");
        wrap.querySelectorAll(".nav_dropdown_contain, .nav_dropdown_mask, .nav_dropdown_layout").forEach(function (el) {
          el.style.setProperty("opacity", "1", "important");
        });
      });
      wrap.addEventListener("mouseleave", function () {
        wrap.classList.remove("active");
      });
      var toggle = wrap.querySelector(".nav_dropdown_toggle_wrap, button, a");
      if (toggle) {
        toggle.addEventListener("click", function (event) {
          if (window.matchMedia && window.matchMedia("(max-width: 991px)").matches) return;
          event.preventDefault();
          var open = wrap.classList.contains("active");
          document.querySelectorAll(".nav_dropdown_wrap").forEach(function (other) {
            other.classList.remove("active");
          });
          if (!open) wrap.classList.add("active");
        });
      }
    });
  }

  function parkContactForm() {
    var form = document.querySelector(".contact-form-wrapper");
    if (!form) return;
    form.style.position = "fixed";
    form.style.top = "0";
    if (!form.style.right || form.style.right === "0px") {
      form.style.right = "-800px";
    }
    document.querySelectorAll(".slide-form-trigger").forEach(function (el) {
      el.style.pointerEvents = "none";
    });
  }

  function ensureLoginNav() {
    if (/login\.html$/i.test(window.location.pathname)) return;
    if (!document.querySelector(".s4c-login-nav-btn, a[href*='login.html']")) {
      var wrap = document.querySelector(".nav_btn_dekstop");
      if (wrap) {
        var link = makeLoginLink("s4c-login-nav-btn w-inline-block");
        var contact = wrap.querySelector("a[href*='contact']");
        if (contact) wrap.insertBefore(link, contact);
        else wrap.appendChild(link);
      }
    }
    var mobile = document.querySelector(".nav_menu_layout");
    if (mobile && !mobile.querySelector(".s4c-login-nav-btn, a[href*='login.html']")) {
      var mobileLink = makeLoginLink("s4c-login-nav-btn w-inline-block");
      mobileLink.style.margin = "0.75rem 0";
      mobile.appendChild(mobileLink);
    }
  }

  function ensureMobileMenu() {
    var toggle = document.getElementById("nav-menu-toggle");
    var nav = document.querySelector(".nav_component");
    if (!toggle || !nav || toggle.getAttribute("data-s4c-menu") === "1") return;
    toggle.setAttribute("data-s4c-menu", "1");
    toggle.addEventListener(
      "click",
      function (event) {
        if (window.navigationState) return;
        event.preventDefault();
        var open = !nav.classList.contains("open");
        nav.classList.toggle("open", open);
        document.body.classList.toggle("u-overflow-hidden", open);
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      },
      true
    );
  }

  function labelFooterLogo() {
    var wrap = document.querySelector(".footer_header_logo1_wrap");
    if (!wrap || wrap.querySelector(".s4c-footer-wordmark")) return;
    var mark = document.createElement("span");
    mark.className = "s4c-footer-wordmark";
    mark.textContent = "Space4Climate";
    wrap.appendChild(mark);
  }

  function stampCopyright() {
    var year = String(new Date().getFullYear());
    document.querySelectorAll(".copyright-year").forEach(function (el) {
      el.textContent = year;
    });
  }

  function preventSplitTextReload() {
    var ignoreReload = false;
    var originalReload = window.location.reload.bind(window.location);
    window.addEventListener(
      "resize",
      function () {
        ignoreReload = true;
        setTimeout(function () {
          ignoreReload = false;
        }, 600);
      },
      true
    );
    window.location.reload = function (forcedReload) {
      if (ignoreReload) return;
      originalReload(forcedReload);
    };
  }

  function run() {
    ensurePerfStyles();
    lockSplitText();
    disarmScrollAnimations();
    enhanceEmbeds();
    flattenScrollHijack();
    tameVideos();
    lazyBelowFoldImages();
    preventSplitTextReload();
    stopIx2ScrollEngine();
    killScrollTriggers();
    parkContactForm();
    flattenProgramCards();
    enhanceDropdowns();
    ensureLoginNav();
    ensureMobileMenu();
    labelFooterLogo();
    stampCopyright();

    var passes = 0;
    var timer = setInterval(function () {
      disarmScrollAnimations();
      killScrollTriggers();
      flattenScrollHijack();
      flattenProgramCards();
      passes += 1;
      if (passes >= 15) clearInterval(timer);
    }, 200);
  }

  ensurePerfStyles();
  lockSplitText();
  disarmScrollAnimations();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
}());
