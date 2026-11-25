function u4(c)
k = Gizmo();
try
  if c
    k = [1 2] + [1 2 3];
    return;
  end
catch
end
tidy(k);
end
