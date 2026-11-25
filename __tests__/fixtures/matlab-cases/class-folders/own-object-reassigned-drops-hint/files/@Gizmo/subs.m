function g = subs(g, n)
if n > 0
  g = subs(g, n - 1);
end
tidy(g);
end
