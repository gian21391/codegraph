function r = shared(x)
nest();
total = total + x;
r = total;
    function nest()
        total = 5;
    end
end
