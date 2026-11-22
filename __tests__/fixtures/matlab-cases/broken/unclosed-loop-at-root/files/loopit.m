for k = 1:3;
  q = Quat(k);
  q.inv();
  cleanupAll
  while getVal(k)<0.1
