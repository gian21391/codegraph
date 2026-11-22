function f(x)
fs = {@pa, @pq};
for k = 1:2
  g = fs{k};
  g(x, 2);
end
end
