function main()
v = probe;
feval('probe', 2);
probe(2);
zt(1);
end
function runs()
probe
end
function empty()
probe();
end
function byname()
feval('probe');
end
function handle()
h = @probe;
end
