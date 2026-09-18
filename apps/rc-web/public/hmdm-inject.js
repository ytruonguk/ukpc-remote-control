(function () {
  if (!window.location.pathname.includes('devices')) return;
  var rows = document.querySelectorAll('table tr');
  rows.forEach(function (row) {
    var num = row.getAttribute('data-device-number') || (row.querySelector('td') || {}).textContent;
    if (!num || row.querySelector('.rc-link')) return;
    var a = document.createElement('a');
    a.className = 'rc-link';
    a.textContent = 'Remote';
    a.target = '_blank';
    a.href = 'https://rc.you.vn/d/' + encodeURIComponent(num.trim()) + '?src=hmdm';
    row.appendChild(a);
  });
})();
