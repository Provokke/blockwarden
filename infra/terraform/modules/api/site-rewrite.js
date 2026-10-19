// A CloudFront viewer-request function (cloudfront-js-2.0) on the site's default behaviour only. S3 has no
// notion of a directory index, and the dashboard is a static export built with trailingSlash: true, so the page
// for /rules is the object rules/index.html. A path whose last segment has a dot is a file and passes through.
// This must never run on /v1/*, where every path is extensionless and belongs to the API.
function handler(event) {
  var request = event.request
  var uri = request.uri
  if (uri.charAt(uri.length - 1) === '/') {
    request.uri = uri + 'index.html'
  } else if (uri.slice(uri.lastIndexOf('/') + 1).indexOf('.') === -1) {
    request.uri = uri + '/index.html'
  }
  return request
}
