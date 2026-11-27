zklpq = 1;
for k = 1:3
  zklpq(1)
  clear zklpq
  try
    error('zk:stop', 'stop');
  catch
    break
  end
end
