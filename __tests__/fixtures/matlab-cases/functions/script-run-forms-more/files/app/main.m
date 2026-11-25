function main()
zt(1);
end
function sp()
probe( );
end
function inif(c)
if c, probe, end
end
function fh()
feval(@probe);
end
function fh1()
feval(@probe, 1);
end
function rn()
run('probe');
end
function sf()
f = str2func('probe');
f();
end
function sf1()
f = str2func('probe');
f(1);
end
function cf()
cellfun(@probe, {1});
end
function asg()
v = probe();
end
