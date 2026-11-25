function b = all(x, c)
if c
  x = x ~= 0;
else
  x = x == 0;
end
b = sum(x);
zt(1);
end
