function r = fuse(x, y)
p = toList(x);
q = toList(y);
for i = 1:length(q)
    t(i) = joinAll(q(i), p, 1);
end
r = t;
end
