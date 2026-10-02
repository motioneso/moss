/* Each button in .mk-bar [data-group] sets data-<group> on body; elements with data-show="group:value value" appear only then. */
(function(){
  var bar=document.querySelector('.mk-bar');
  function apply(){
    document.querySelectorAll('[data-show]').forEach(function(el){
      var ok=el.getAttribute('data-show').split(';').every(function(rule){
        var p=rule.split(':'),g=p[0].trim(),vals=p[1].trim().split(/\s+/);
        return vals.indexOf(document.body.getAttribute('data-'+g))>-1;
      });
      el.classList.toggle('mk-hide',!ok);
    });
    document.querySelectorAll('[data-pick]').forEach(function(b){
      var p=b.getAttribute('data-pick').split(':');
      b.setAttribute('aria-pressed',document.body.getAttribute('data-'+p[0])===p[1]);
    });
  }
  bar.addEventListener('click',function(e){
    var b=e.target.closest('[data-pick]');if(!b)return;
    var p=b.getAttribute('data-pick').split(':');
    if(p[0]==='theme'){document.documentElement.removeAttribute('data-color-mode');document.documentElement.removeAttribute('data-theme');
      if(p[1]==='dark')document.documentElement.setAttribute('data-color-mode','dark');
      else if(p[1]!=='light')document.documentElement.setAttribute('data-theme',p[1]);}
    document.body.setAttribute('data-'+p[0],p[1]);apply();
  });
  document.querySelectorAll('[data-default]').forEach(function(b){document.body.setAttribute('data-'+b.getAttribute('data-default').split(':')[0],b.getAttribute('data-default').split(':')[1]);});
  apply();
})();
