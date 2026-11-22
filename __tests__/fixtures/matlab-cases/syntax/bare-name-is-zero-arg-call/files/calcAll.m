function r = calcAll(x)
data = loadData;
r = data(3) + helperB(x);
[a, b] = splitIt(x);
r = r + a(1) + b(2);
end
