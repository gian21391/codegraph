function wait2()
done = false;
while ~done
    pause(1);
end
    function onClick(src, evt)
        done = true;
    end
end
