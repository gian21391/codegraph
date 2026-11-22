function handles(x, fp)
fh = @solve;
y = fh(x);
z = fp(x);
g = str2func('helper');
g(1);
end
