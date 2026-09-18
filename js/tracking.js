/**
 * LinkedIn -> JVZoo tracking bridge.
 *
 * 1. Reads `li_fat_id` (LinkedIn's First-Party Ad Tracking Click ID) from the
 *    current page URL. This param is appended automatically by LinkedIn when
 *    Enhanced Conversion Tracking is enabled on the Insight Tag.
 * 2. If present, asks the Cloudflare Worker to mint a `tracking_id` and store
 *    `tracking_id -> li_fat_id` in KV.
 * 3. Appends that `tracking_id` to every JVZoo affiliate link on the page
 *    using JVZoo's officially documented affiliate tracking parameter: `tid`.
 *    JVZoo echoes this back as `caffitid` ("affiliate tracking id") in the
 *    real-time JVZIPN v1 postback. Confirmed against the current official
 *    docs at https://support.jvzoo.com/hc/en-us/articles/206456857 and the
 *    JVZoo v3.0 REST API schema (`tracking.tid`). No undocumented/invented
 *    param is used.
 *
 * If there is no `li_fat_id`, or the Worker request fails, this script does
 * nothing and the existing CTA links keep working exactly as before.
 */
(function () {
  "use strict";

  var TRACK_ENDPOINT = "https://aff-tracking-worker.medusedmed.workers.dev/api/track";
  var TRACKING_PARAM = "tid";
  // Matches JVZoo's affiliate redirect domains: jvzoo.com, jvz1.com, jvz5.com,
  // jvz7.com, jvz8.com, etc.
  var JVZOO_HOST_RE = /^(www\.)?jvz\w*\.com$/i;

  function getJvzooLinks() {
    var anchors = document.querySelectorAll("a[href]");
    var result = [];
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      try {
        var url = new URL(a.href, window.location.href);
        if (JVZOO_HOST_RE.test(url.hostname)) {
          result.push(a);
        }
      } catch (e) {
        // Ignore malformed hrefs.
      }
    }
    return result;
  }

  function appendTrackingIdToLinks(trackingId) {
    var links = getJvzooLinks();
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      try {
        var url = new URL(a.href, window.location.href);
        url.searchParams.set(TRACKING_PARAM, trackingId);
        a.href = url.toString();
      } catch (e) {
        // Leave this link untouched on failure; never break navigation.
      }
    }
  }

  function init() {
    var liFatId = new URLSearchParams(window.location.search).get("li_fat_id");
    if (!liFatId) {
      return;
    }

    fetch(TRACK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ li_fat_id: liFatId }),
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error("track request failed with status " + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        if (data && data.tracking_id) {
          appendTrackingIdToLinks(data.tracking_id);
        }
      })
      .catch(function () {
        // Fail silently: CTA links keep their original, working URLs.
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
