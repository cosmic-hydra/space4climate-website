(function () {
  var doc = document.documentElement;
  if (doc) {
    doc.classList.add('s4c-js');
    doc.setAttribute('data-js', 'enabled');
  }

  function getMediaLabel(element, fallback) {
    var label = element.getAttribute('title') || element.getAttribute('aria-label');
    if (label) return label;

    var container = element.closest('section, article, div, figure');
    if (container) {
      var heading = container.querySelector('h1, h2, h3, h4, h5, h6');
      if (heading && heading.textContent.trim()) {
        return heading.textContent.trim();
      }
    }

    return fallback;
  }

  function enhanceEmbeds() {
    var embeds = document.querySelectorAll('iframe, video, audio');
    embeds.forEach(function (element, index) {
      element.setAttribute('data-js-enhanced', 'true');

      if (element.tagName === 'IFRAME') {
        if (!element.hasAttribute('loading')) {
          element.setAttribute('loading', 'lazy');
        }
        if (!element.hasAttribute('referrerpolicy')) {
          element.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
        }
        if (!element.hasAttribute('allow')) {
          element.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; encrypted-media');
        }
        element.setAttribute('allowfullscreen', '');
        if (!element.getAttribute('title')) {
          element.setAttribute('title', getMediaLabel(element, 'Embedded media ' + (index + 1)));
        }
      }

      if (element.tagName === 'VIDEO' || element.tagName === 'AUDIO') {
        if (!element.hasAttribute('preload')) {
          element.setAttribute('preload', 'metadata');
        }
        if (!element.hasAttribute('controls')) {
          element.setAttribute('controls', 'controls');
        }
        if (element.tagName === 'VIDEO') {
          element.setAttribute('playsinline', 'playsinline');
        }
        if (!element.getAttribute('aria-label') && !element.getAttribute('title')) {
          element.setAttribute('aria-label', getMediaLabel(element, 'Media playback ' + (index + 1)));
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhanceEmbeds, { once: true });
  } else {
    enhanceEmbeds();
  }
}());
